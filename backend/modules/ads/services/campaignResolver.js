// Resolve a web lead's free-text `utm_campaign` string to a Meta campaign.
//
// The retired CRM joined leads to spend by comparing `utmCampaign` to a campaign
// NAME with `===` (see focas-crm/frontend/src/components/UtmReport.tsx). That is
// brittle: "CA Foundation | Jun" vs "ca-foundation-jun" is the same campaign to a
// human and two different campaigns to a string compare, so the lead silently
// showed a blank CPL and nobody could tell whether the tagging was wrong or the
// spend was missing.
//
// So we try three things in decreasing order of confidence and RECORD WHICH ONE
// WON. `resolvedBy` is the whole point: a cost derived from an id match is a hard
// fact, one derived from a normalized name match is an inference, and the UI has
// to be able to say which it is showing.
//
// An unresolved lead is a normal outcome, not an error — plenty of leads arrive
// with no UTM at all. Callers must handle `{ campaignId: null, resolvedBy: null }`.

const MetaCampaign = require('../models/MetaCampaign');

// The campaign list is tiny (tens of rows) but this is called once per lead by
// the backfill, so it is cached rather than re-queried thousands of times. Short
// TTL: a campaign created by the sync minutes ago must start resolving without a
// restart, and a 60s window is cheap insurance against a stale miss.
const TTL_MS = Number(process.env.CAMPAIGN_INDEX_TTL_MS || 60000);

let index = null;
let indexedAt = 0;
let loading = null;

/**
 * The normalization used for the third attempt: lowercase, then drop everything
 * that is not a letter or a digit. "CA Foundation | Jun'25" and
 * "ca_foundation_jun25" both collapse to "cafoundationjun25".
 */
function normalizeName(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Meta allows two live campaigns to share a name, so a name lookup can be
 * ambiguous. Resolve that deterministically rather than by whatever order Mongo
 * happened to return: newest campaign first, id as the tie-break. A UTM tag being
 * written today refers to the campaign running today, and "deterministic" matters
 * because the backfill must produce the same answer every time it runs.
 */
function bestFirst(a, b) {
  const at = a.createdTime || '';
  const bt = b.createdTime || '';
  if (at !== bt) return at < bt ? 1 : -1; // newest createdTime first
  const ai = String(a._id);
  const bi = String(b._id);
  return ai < bi ? 1 : ai > bi ? -1 : 0; // then highest id first
}

async function buildIndex() {
  const rows = await MetaCampaign.find({}, { name: 1, createdTime: 1 }).lean();
  rows.sort(bestFirst);

  const ids = new Set();
  const byName = new Map();
  const byNormalized = new Map();

  for (const row of rows) {
    const id = String(row._id);
    ids.add(id);
    if (row.name == null) continue;
    const name = String(row.name);
    // First writer wins, and `rows` is sorted best-first — so a duplicate name
    // resolves to the newest campaign carrying it.
    if (!byName.has(name)) byName.set(name, id);
    const normalized = normalizeName(name);
    if (normalized && !byNormalized.has(normalized)) byNormalized.set(normalized, id);
  }

  return { ids, byName, byNormalized };
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

/** Drop the cached campaign list — call after a sync has written new campaigns. */
function invalidate() {
  index = null;
  indexedAt = 0;
}

/**
 * @param {string|null|undefined} utmCampaign the raw utm_campaign value
 * @returns {Promise<{campaignId: string|null, resolvedBy: 'exact'|'normalized'|'id'|null}>}
 */
async function resolveCampaign(utmCampaign) {
  const unresolved = { campaignId: null, resolvedBy: null };
  if (utmCampaign == null) return unresolved;

  const raw = String(utmCampaign);
  if (!raw.trim()) return unresolved;

  const { ids, byName, byNormalized } = await getIndex();

  // 1. The tag IS the campaign id. Nothing to infer — this is the only method
  //    that cannot be wrong, which is why it is tried first even though almost
  //    no ad is tagged this way today.
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed) && ids.has(trimmed)) {
    return { campaignId: trimmed, resolvedBy: 'id' };
  }

  // 2. Verbatim name match — what the old CRM did, kept as the strongest of the
  //    name-based methods. Deliberately NOT trimmed: a tag with a stray space is
  //    a tagging drift and should report as `normalized`, not as an exact hit.
  const exact = byName.get(raw);
  if (exact) return { campaignId: exact, resolvedBy: 'exact' };

  // 3. Case / spacing / punctuation differences only.
  const normalized = normalizeName(raw);
  if (normalized) {
    const loose = byNormalized.get(normalized);
    if (loose) return { campaignId: loose, resolvedBy: 'normalized' };
  }

  // 4. Genuinely unattributable. The backfill reports these distinct strings so
  //    the operator can fix the ad URLs at source.
  return unresolved;
}

module.exports = { resolveCampaign, normalizeName, invalidate };
