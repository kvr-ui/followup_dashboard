// Guard tests for the agent's aggregation escape hatch.
//
//   node modules/agent/scripts/testMongoQuery.js
//
// No database and no test framework: every case exercises the validator
// directly, which is the part that has to be right. A failure here is not a
// wrong number on a dashboard, it is a rep reading another rep's pipeline or a
// model writing to the database, so these run fast enough to run every time.

const {
  _internals: { validateStages, scanForbidden, ownerStages, QueryRejected },
} = require('../services/mongoQuery');

/** The single $match stage the scoping produces, for the simple collections. */
const ownerMatch = (collection, scope) => {
  const stages = ownerStages(collection, scope);
  return stages.length ? stages[0] : null;
};

const ADMIN = { isAdmin: true, ownerEmail: 'boss@focasedu.com' };
const REP = { isAdmin: false, ownerEmail: 'Rep@FocasEdu.com' };

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}\n    ${err.message}`);
  }
}

/** The pipeline must be refused, and the reason must mention `expect`. */
function rejects(name, pipeline, scope, expect) {
  check(name, () => {
    let threw = null;
    try {
      validateStages(pipeline, scope);
      scanForbidden(pipeline);
    } catch (err) {
      threw = err;
    }
    if (!threw) throw new Error('expected a rejection, but the pipeline was accepted');
    if (!(threw instanceof QueryRejected)) throw new Error(`threw the wrong error: ${threw}`);
    if (expect && !threw.message.includes(expect)) {
      throw new Error(`rejected for the wrong reason: "${threw.message}"`);
    }
  });
}

function accepts(name, pipeline, scope) {
  check(name, () => {
    validateStages(pipeline, scope);
    scanForbidden(pipeline);
  });
}

// ── Writes ───────────────────────────────────────────────────────────────────
rejects('$out is refused', [{ $match: {} }, { $out: 'stolen' }], ADMIN, '$out');
rejects(
  '$merge is refused',
  [{ $match: {} }, { $merge: { into: 'deals' } }],
  ADMIN,
  '$merge'
);

// ── Server-side code execution ───────────────────────────────────────────────
rejects('$where is refused', [{ $match: { $where: 'this.amount > 0' } }], ADMIN, '$where');
rejects(
  '$function is refused',
  [{ $addFields: { x: { $function: { body: 'function(){}', args: [], lang: 'js' } } } }],
  ADMIN,
  '$function'
);
rejects(
  '$accumulator is refused',
  [{ $group: { _id: null, x: { $accumulator: { init: 'function(){}', lang: 'js' } } } }],
  ADMIN,
  '$accumulator'
);
rejects(
  '$function nested three levels inside $expr is refused',
  [
    {
      $match: {
        $expr: {
          $and: [
            { $gt: ['$amount', 0] },
            { $eq: [{ $function: { body: 'function(){return 1}', args: [], lang: 'js' } }, 1] },
          ],
        },
      },
    },
  ],
  ADMIN,
  '$function'
);
rejects(
  '$function hidden inside a $facet branch is refused',
  [{ $facet: { a: [{ $match: { $where: 'true' } }] } }],
  ADMIN,
  '$where'
);
rejects(
  '$function hidden inside a $lookup sub-pipeline is refused',
  [
    {
      $lookup: {
        from: 'calls',
        as: 'c',
        pipeline: [{ $addFields: { z: { $function: { body: 'f', args: [], lang: 'js' } } } }],
      },
    },
  ],
  ADMIN,
  '$function'
);

// ── Stages that reach other collections on their own terms ───────────────────
rejects(
  '$unionWith is refused',
  [{ $match: {} }, { $unionWith: { coll: 'users' } }],
  ADMIN,
  '$unionWith'
);
rejects(
  '$graphLookup is refused',
  [{ $graphLookup: { from: 'tasks', startWith: '$x', connectFromField: 'a', connectToField: 'b', as: 'c' } }],
  ADMIN,
  '$graphLookup'
);

// ── The users collection is unreachable ──────────────────────────────────────
rejects(
  '$lookup into users is refused',
  [{ $lookup: { from: 'users', localField: 'ownerEmail', foreignField: 'ownerEmail', as: 'u' } }],
  ADMIN,
  'not an allowed collection'
);

// ── Scoping ──────────────────────────────────────────────────────────────────
rejects(
  'a rep cannot $lookup at all',
  [{ $lookup: { from: 'calls', localField: 'contactPhoneKey', foreignField: 'phoneKeys', as: 'c' } }],
  REP,
  'non-admin'
);

check('a rep gets an owner filter, case-insensitively', () => {
  const stage = ownerMatch('calls', REP);
  if (!stage) throw new Error('no owner filter was produced');
  const rx = stage.$match.ownerEmail;
  if (!(rx instanceof RegExp)) throw new Error('owner filter is not a regex');
  if (!rx.test('rep@focasedu.com')) throw new Error('does not match the lower-case form');
  if (!rx.test('REP@FOCASEDU.COM')) throw new Error('does not match the upper-case form');
  if (rx.test('other@focasedu.com')) throw new Error('matches a DIFFERENT rep — leak');
  if (rx.test('xrep@focasedu.com')) throw new Error('is not anchored at the start — leak');
  if (rx.test('rep@focasedu.com.evil.test')) throw new Error('is not anchored at the end — leak');
});

check('an owner address is escaped, not treated as a pattern', () => {
  const rx = ownerMatch('calls', { isAdmin: false, ownerEmail: 'a.b+x@focasedu.com' }).$match
    .ownerEmail;
  if (rx.test('axb+x@focasedu.com')) throw new Error('the dot was left as a wildcard — leak');
  if (!rx.test('a.b+x@focasedu.com')) throw new Error('the literal address no longer matches');
});

check('a rep with no ownerEmail matches nothing, not everything', () => {
  const stage = ownerMatch('deals', { isAdmin: false, ownerEmail: null });
  if (stage.$match.ownerEmail !== '__no_owner_email__') {
    throw new Error(`open scope for an unmapped rep: ${JSON.stringify(stage)}`);
  }
});

check('an admin gets no owner filter', () => {
  if (ownerStages('calls', ADMIN).length !== 0) {
    throw new Error('an admin was scoped to themselves');
  }
});

check('an admin-only collection cannot be owner-scoped', () => {
  let threw = false;
  try {
    ownerStages('metainsights', REP);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error('metainsights was silently scoped instead of refused');
});

// A tasks document is one contact, and its `body` may be an ARRAY of tasks
// belonging to several reps. Matching the document is not enough.
check('a shared contact does not leak another rep\'s tasks', () => {
  const stages = ownerStages('tasks', REP);
  if (stages.length !== 2) {
    throw new Error(`expected a $match AND a body filter, got ${stages.length} stage(s)`);
  }
  const filter = stages[1].$addFields.body.$cond[1].$filter;
  if (!filter) throw new Error('the body array is not filtered');
  const wanted = filter.cond.$eq[1];
  if (wanted !== 'rep@focasedu.com') {
    throw new Error(`the body filter compares against the wrong address: ${wanted}`);
  }
});

check('an unmapped rep on tasks still matches nothing', () => {
  const stages = ownerStages('tasks', { isAdmin: false, ownerEmail: '' });
  if (stages[0].$match['body.Owner.email'] !== '__no_owner_email__') {
    throw new Error('open scope for an unmapped rep on tasks');
  }
});

// ── Row cap ──────────────────────────────────────────────────────────────────
rejects('an oversized $limit is refused', [{ $match: {} }, { $limit: 100000 }], ADMIN, 'cap');
rejects('a negative $limit is refused', [{ $limit: -1 }], ADMIN, '$limit');

// ── Shape ────────────────────────────────────────────────────────────────────
rejects('a non-array pipeline is refused', { $match: {} }, ADMIN, 'must be an array');
rejects('an empty pipeline is refused', [], ADMIN, 'empty');
rejects(
  'a two-operator stage is refused',
  [{ $match: {}, $limit: 5 }],
  ADMIN,
  'exactly one operator'
);
rejects('an unknown stage is refused', [{ $bogus: {} }], ADMIN, 'not allowed');

// ── Things that must still work ──────────────────────────────────────────────
accepts(
  'a plain grouped aggregation is accepted',
  [
    { $match: { outcome: 'won', closingDate: { $gte: '2026-07-01' } } },
    { $group: { _id: '$leadSourceKey', revenue: { $sum: '$amount' }, n: { $sum: 1 } } },
    { $sort: { revenue: -1 } },
    { $limit: 20 },
  ],
  ADMIN
);
accepts(
  'a rep may still aggregate their own rows',
  [
    { $match: { outcome: 'lost' } },
    { $group: { _id: '$lostReason', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ],
  REP
);
accepts(
  'an admin may join two allowed collections',
  [
    { $match: { outcome: 'won' } },
    { $lookup: { from: 'calls', localField: 'contactPhoneKey', foreignField: 'phoneKeys', as: 'calls' } },
    { $project: { name: 1, amount: 1, callCount: { $size: '$calls' } } },
  ],
  ADMIN
);
accepts(
  '$expr without $function is fine',
  [{ $match: { $expr: { $gt: ['$amount', '$installment'] } } }],
  ADMIN
);
accepts('a $facet of two clean branches is fine', [
  { $facet: { won: [{ $match: { outcome: 'won' } }], lost: [{ $match: { outcome: 'lost' } }] } },
], ADMIN);

// ── Report ───────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}\n`));
  process.exit(1);
}
console.log(`${passed} guard tests passed.`);
