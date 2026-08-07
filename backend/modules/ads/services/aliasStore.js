// Read and write the operator's UTM -> campaign alias table (models/CampaignAlias).
//
// Two callers with opposite needs, which is why this file exists rather than the
// model being used directly:
//
//   * campaignResolver reads it once per lead — tens of thousands of times during
//     a backfill — so reads go through a cached index with the same short TTL the
//     resolver's campaign index uses.
//   * the admin routes and the seed script write it a row at a time, and every
//     write drops that cache. An alias the operator just added has to take effect
//     on the next resolve, not up to a minute later.
//
// This module knows nothing about resolution ORDER — that is the resolver's
// business, and the whole point of the alias tier being last. It only stores and
// returns what the operator asserted.

const CampaignAlias = require('../models/CampaignAlias');
const { normalizeName } = require('./normalizeName');

// Same TTL as the resolver's campaign index, and for the same reason: long enough
// that a backfill is not re-reading the collection per lead, short enough that a
// change made elsewhere (another process, a script) shows up without a restart.
const TTL_MS = Number(process.env.CAMPAIGN_ALIAS_TTL_MS || process.env.CAMPAIGN_INDEX_TTL_MS || 60000);

let index = null;
let indexedAt = 0;
let loading = null;

/** The alias key for a raw UTM string. Empty string means "cannot be aliased". */
function keyFor(utmCampaign) {
  return normalizeName(utmCampaign);
}

async function buildIndex() {
  const rows = await CampaignAlias.find({}, { campaignId: 1, utmCampaign: 1, note: 1 }).lean();
  const map = new Map();
  for (const row of rows) {
    const key = String(row._id);
    if (!key) continue;
    map.set(key, {
      key,
      utmCampaign: row.utmCampaign == null ? null : String(row.utmCampaign),
      // Normalised to null once, here, so a row written with '' behaves exactly
      // like one written with null — both mean "deliberately unmapped".
      campaignId: row.campaignId ? String(row.campaignId) : null,
      note: row.note == null ? null : String(row.note),
    });
  }
  return map;
}

async function getIndex() {
  if (index && Date.now() - indexedAt < TTL_MS) return index;
  if (!loading) {
    loading = buildIndex()
      .then((built) => {
        index = built;
        indexedAt = Date.now();
        return built;
      })
      .finally(() => {
        loading = null;
      });
  }
  // Concurrent callers share one query instead of stampeding the collection.
  return loading;
}

/** Drop the cached table. Called by every write here, and by the resolver's own invalidate(). */
function invalidate() {
  index = null;
  indexedAt = 0;
}

/**
 * The alias for an ALREADY-NORMALIZED key.
 *
 * Takes the normalized form rather than the raw string because the resolver has
 * computed it already for its third tier, and computing it twice is how the two
 * ever come to disagree. Use `keyFor` if you are holding a raw UTM string.
 *
 * @param {string} key
 * @returns {Promise<{key: string, utmCampaign: string|null, campaignId: string|null, note: string|null}|null>}
 *   null means NOT TRIAGED. A row with `campaignId: null` means triaged and
 *   deliberately unmapped — a different thing, and the caller must tell them apart.
 */
async function lookup(key) {
  if (!key) return null;
  const map = await getIndex();
  return map.get(String(key)) || null;
}

/** Every alias, straight from the database (no cache) — for the admin list. */
function list() {
  // Newest first: the operator's most recent decisions are the ones under review.
  return CampaignAlias.find({}).sort({ updatedAt: -1, _id: 1 }).lean();
}

/** One alias by key, straight from the database. */
function get(key) {
  if (!key) return Promise.resolve(null);
  return CampaignAlias.findById(String(key)).lean();
}

function actorOf(actor) {
  if (!actor) return { id: null, name: null };
  return {
    id: actor.id == null ? null : String(actor.id),
    name: actor.name == null ? null : String(actor.name),
  };
}

/**
 * Create or replace one alias, keyed on the normalized UTM.
 *
 * Idempotent by construction: the key is derived from the UTM string, so writing
 * the same alias twice is one upsert onto the same `_id`, and `createdBy` is only
 * set on insert — a re-seed does not rewrite who first made the call.
 *
 * @param {{utmCampaign: string, campaignId?: string|null, note?: string|null, actor?: {id?: *, name?: *}}} input
 * @returns {Promise<{created: boolean, alias: object}>}
 */
async function upsert(input) {
  const utmCampaign = String(input.utmCampaign);
  const key = keyFor(utmCampaign);
  if (!key) throw new Error(`'${utmCampaign}' has no alias key (nothing alphanumeric in it)`);

  const campaignId = input.campaignId ? String(input.campaignId) : null;
  const note = input.note == null || input.note === '' ? null : String(input.note);
  const by = actorOf(input.actor);

  const result = await CampaignAlias.updateOne(
    { _id: key },
    {
      $set: { utmCampaign, campaignId, note, updatedBy: by },
      $setOnInsert: { createdBy: by },
    },
    { upsert: true }
  );

  invalidate();

  const alias = await CampaignAlias.findById(key).lean();
  return { created: Boolean(result.upsertedCount), alias };
}

/**
 * Delete an alias — the operator UNTRIAGING a UTM string, which puts it straight
 * back on the actionable unresolved list. The leads already resolved through it
 * keep their stored campaign until the backfill is re-run; that is the backfill's
 * job, not this one's.
 *
 * @returns {Promise<boolean>} false when there was nothing to delete
 */
async function remove(key) {
  if (!key) return false;
  const result = await CampaignAlias.deleteOne({ _id: String(key) });
  if (result.deletedCount) invalidate();
  return Boolean(result.deletedCount);
}

module.exports = { keyFor, lookup, list, get, upsert, remove, invalidate };
