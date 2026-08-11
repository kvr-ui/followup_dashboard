// The escape hatch: a model-written MongoDB aggregation, run read-only.
//
// The twelve curated tools cover the questions we could think of. This covers the
// ones we couldn't — "who has a pending installment over 50k and no call in the
// last fortnight" is not a report anybody built, and shouldn't need to be.
//
// The price of that flexibility is that an LLM is now writing database queries,
// so this file fails CLOSED on everything it does not explicitly recognise:
//
//   * only collections listed in schemaDoc.js — `users` (bcrypt hashes) is not
//     among them and never will be
//   * only an allowlist of stages; anything else, including every stage that can
//     WRITE ($out, $merge) or EXECUTE ($function, $where, $accumulator), is
//     rejected before Mongo is touched
//   * the forbidden-operator scan is RECURSIVE, because `$expr: { $function: … }`
//     buried six levels inside a `$match` is still arbitrary server-side JS
//   * a sales rep's owner filter is PREPENDED by this file, not supplied by the
//     model, and $lookup — which would join past that filter into an unscoped
//     collection — is refused for reps outright
//   * hard row cap and a maxTimeMS, so a bad pipeline is a slow answer rather
//     than a stalled database
//
// A bug anywhere else in this module produces a wrong answer. A bug here
// produces a data breach, which is why the rules are enumerated rather than
// inferred, and why every one of them has a test in
// modules/agent/scripts/testMongoQuery.js.

const { COLLECTIONS } = require('./schemaDoc');

// Stages that only read, reshape or reduce. Deliberately conservative: adding a
// stage here is a security decision, so the list is short and the omissions are
// intentional. $graphLookup and $unionWith are absent because both reach into
// other collections on their own terms; $out and $merge because they write.
const ALLOWED_STAGES = new Set([
  '$match',
  '$project',
  '$group',
  '$sort',
  '$limit',
  '$skip',
  '$unwind',
  '$count',
  '$addFields',
  '$set',
  '$lookup',
  '$facet',
  '$sortByCount',
  '$replaceRoot',
  '$bucket',
]);

// Operators that execute code, write data, or read server internals. Searched for
// at ANY depth, as keys or as string values — a $where can arrive as a bare
// string, and $function hides comfortably inside $expr.
const FORBIDDEN_OPERATORS = new Set([
  '$where',
  '$function',
  '$accumulator',
  '$out',
  '$merge',
  '$graphLookup',
  '$unionWith',
  '$listSessions',
  '$listLocalSessions',
  '$currentOp',
  '$collStats',
  '$indexStats',
  '$planCacheStats',
  '$documents',
  '$changeStream',
  '$sample',
  '$geoNear',
  '$search',
  '$searchMeta',
  '$vectorSearch',
]);

const MAX_STAGES = 25;
const MAX_ROWS = 500;
const MAX_TIME_MS = 10000;
const MAX_DEPTH = 40;

class QueryRejected extends Error {}

/**
 * A JSON-safe copy of the pipeline, for the echo we hand back to the model and
 * the UI.
 *
 * `JSON.stringify(/^rep@focas\.com$/i)` is `{}`, which would render the owner
 * filter — the whole point of the echo — as an empty object. A user checking that
 * their query really was scoped would see nothing there and conclude it wasn't.
 */
function displayable(node) {
  if (node instanceof RegExp) return `/${node.source}/${node.flags}`;
  if (Array.isArray(node)) return node.map(displayable);
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, displayable(v)]));
  }
  return node;
}

function reject(msg) {
  throw new QueryRejected(msg);
}

/**
 * Walk anything — object, array, scalar — looking for operators that must never
 * reach the server. Depth-limited so a self-referential structure can't hang the
 * validator instead of the database.
 */
function scanForbidden(node, depth = 0, path = '') {
  if (depth > MAX_DEPTH) reject('Pipeline is nested too deeply.');
  if (node === null || node === undefined) return;

  if (Array.isArray(node)) {
    node.forEach((item, i) => scanForbidden(item, depth + 1, `${path}[${i}]`));
    return;
  }

  if (typeof node !== 'object') return;

  for (const [key, value] of Object.entries(node)) {
    if (FORBIDDEN_OPERATORS.has(key)) {
      reject(`Operator ${key} is not allowed (found at ${path || 'pipeline root'}).`);
    }
    // Some operators can be named in a VALUE rather than a key, e.g.
    // { $expr: { $eq: ["$a", { $function: {...} }] } } is caught above, but a
    // driver-level string form is not — so treat a bare "$function" value as an
    // attempt too. Cheap, and false positives are impossible in real pipelines.
    if (typeof value === 'string' && FORBIDDEN_OPERATORS.has(value)) {
      reject(`Operator ${value} is not allowed (found at ${path}.${key}).`);
    }
    scanForbidden(value, depth + 1, path ? `${path}.${key}` : key);
  }
}

/**
 * Validate one pipeline. Called recursively for the sub-pipelines inside $facet
 * and $lookup, which are otherwise a way to smuggle a banned stage past the
 * top-level check.
 */
function validateStages(pipeline, scope, where = 'pipeline') {
  if (!Array.isArray(pipeline)) reject(`${where} must be an array of stages.`);
  if (pipeline.length === 0) reject(`${where} is empty.`);
  if (pipeline.length > MAX_STAGES) {
    reject(`${where} has ${pipeline.length} stages; the limit is ${MAX_STAGES}.`);
  }

  for (const [i, stage] of pipeline.entries()) {
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
      reject(`${where} stage ${i} is not an object.`);
    }

    const keys = Object.keys(stage);
    if (keys.length !== 1) {
      reject(`${where} stage ${i} must have exactly one operator, found ${keys.length}.`);
    }

    const [name] = keys;
    if (!ALLOWED_STAGES.has(name)) {
      reject(
        `Stage ${name} is not allowed. Permitted stages: ${[...ALLOWED_STAGES].sort().join(', ')}.`
      );
    }

    const body = stage[name];

    if (name === '$limit') {
      if (typeof body !== 'number' || !Number.isFinite(body) || body <= 0) {
        reject('$limit must be a positive number.');
      }
      if (body > MAX_ROWS) {
        reject(`$limit ${body} exceeds the ${MAX_ROWS}-row cap. Aggregate instead of listing.`);
      }
    }

    if (name === '$lookup') {
      // A rep's owner filter applies to the collection being aggregated. A join
      // pulls in rows from a SECOND collection that the filter never touched, so
      // for anyone but an admin this is a hole, not a feature.
      if (!scope.isAdmin) {
        reject('$lookup is not available on a scoped (non-admin) account.');
      }
      const from = body && body.from;
      if (!from || !COLLECTIONS[from]) {
        reject(`$lookup.from "${from}" is not an allowed collection.`);
      }
      if (body.pipeline) validateStages(body.pipeline, scope, `$lookup on ${from}`);
    }

    if (name === '$facet') {
      if (!body || typeof body !== 'object') reject('$facet must be an object.');
      for (const [branch, sub] of Object.entries(body)) {
        validateStages(sub, scope, `$facet.${branch}`);
      }
    }
  }
}

/**
 * The stages that pin a sales rep to their own data, or [] when none are needed.
 *
 * Built here rather than accepted from the caller: the model can ask for any
 * filter it likes, but it cannot ask for these to be absent.
 */
function ownerStages(collection, scope) {
  if (scope.isAdmin) return [];

  const spec = COLLECTIONS[collection];
  if (!spec.ownerField) {
    // Reaching this means an adminOnly collection slipped past the check above.
    reject(`Collection ${collection} cannot be scoped to a single rep.`);
  }

  const mine = String(scope.ownerEmail || '').trim().toLowerCase();
  if (!mine) {
    // A rep with no ownerEmail owns nothing. Match nothing rather than everything.
    return [{ $match: { [spec.ownerField]: '__no_owner_email__' } }];
  }

  let match;
  if (spec.ownerCI) {
    // Bigin does not normalise the case of the address it sends, so an equality
    // match would silently drop a rep's own rows. Anchored and escaped: the
    // address is data, not a pattern.
    const escaped = mine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    match = { $match: { [spec.ownerField]: new RegExp(`^${escaped}$`, 'i') } };
  } else {
    match = { $match: { [spec.ownerField]: mine } };
  }

  const stages = [match];

  // A tasks document is one CONTACT, and `body` is sometimes an ARRAY holding
  // every task raised against them — which can span several reps. The $match
  // above keeps any document where ONE entry belongs to this rep, so without
  // this second stage a shared contact would hand them a colleague's tasks.
  // taskController.listTasks filters the same array in memory for exactly this
  // reason (see the `ownerEmailOf` filter there); this is that rule, expressed
  // as a pipeline stage. `body` is left untouched when it is a single object,
  // since the $match already proved that object is theirs.
  if (spec.bodyArrayOwnerFilter) {
    stages.push({
      $addFields: {
        body: {
          $cond: [
            { $isArray: '$body' },
            {
              $filter: {
                input: '$body',
                as: 'b',
                cond: { $eq: [{ $toLower: { $ifNull: ['$$b.Owner.email', ''] } }, mine] },
              },
            },
            '$body',
          ],
        },
      },
    });
  }

  return stages;
}

/**
 * Validate and run a model-written aggregation.
 *
 * Returns the rows plus the pipeline that ACTUALLY ran, owner filter and all.
 * The echo is not decoration: it is how a user checks the number they were given,
 * and how a rep can see for themselves that the scoping happened.
 */
async function runAggregation({ collection, pipeline }, scope) {
  try {
    const spec = COLLECTIONS[collection];
    if (!spec) {
      const available = Object.keys(COLLECTIONS)
        .filter((c) => scope.isAdmin || !COLLECTIONS[c].adminOnly)
        .join(', ');
      return {
        ok: false,
        error: `Unknown collection "${collection}". Available: ${available}.`,
      };
    }
    if (spec.adminOnly && !scope.isAdmin) {
      return {
        ok: false,
        error: `The ${collection} collection is admin-only (ad spend, lead contact details and provider billing). You do not have access to it.`,
      };
    }

    validateStages(pipeline, scope);
    scanForbidden(pipeline);

    const owner = ownerStages(collection, scope);
    const effective = [...owner, ...pipeline];

    // Cap the output regardless of what the model asked for. A trailing $limit
    // after a $group is harmless; after a $count it is a no-op.
    effective.push({ $limit: MAX_ROWS });

    const rows = await spec.model
      .aggregate(effective)
      .option({ maxTimeMS: MAX_TIME_MS })
      .allowDiskUse(false);

    return {
      ok: true,
      collection,
      rowCount: rows.length,
      // Say so out loud. A model that cannot tell a complete result from a
      // truncated one will happily present the first 500 rows as "all of them".
      truncated: rows.length >= MAX_ROWS,
      scopedToOwner: owner.length > 0,
      pipelineRun: displayable(effective),
      rows,
    };
  } catch (err) {
    if (err instanceof QueryRejected) return { ok: false, error: err.message };
    if (/operation exceeded time limit|MaxTimeMSExpired/i.test(err.message)) {
      return {
        ok: false,
        error: `Query took longer than ${MAX_TIME_MS / 1000}s and was stopped. Narrow it with a $match first.`,
      };
    }
    return { ok: false, error: `Aggregation failed: ${err.message}` };
  }
}

module.exports = {
  runAggregation,
  // Exported for the tests, which check the guard directly rather than through a
  // live database.
  _internals: { validateStages, scanForbidden, ownerStages, QueryRejected, MAX_ROWS },
};
