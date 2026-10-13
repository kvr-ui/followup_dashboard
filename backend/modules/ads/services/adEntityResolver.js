// Resolve a web lead's `utm_term` / `utm_content` to a Meta ad set and ad.
//
// Our click URLs tag `utm_term` with the AD SET ID (see scripts/seedCampaignAliases.js)
// and `utm_content` with the AD NAME — so unlike utm_campaign, the hot path here
// is an id match, which cannot be wrong and survives renames in Meta. Name-based
// matches are the fallback, and `resolvedAdsetBy` / `resolvedAdBy` record which
// method won, for exactly the reason campaignResolver records `resolvedBy`: a
// join from an id is a fact, a join from a name is an inference, and the UI must
// be able to say which it is showing.
//
// CAMPAIGN CONSISTENCY
// --------------------
// A resolved ad set names its own campaign, and that id can disagree with the
// lead's name/alias-resolved `resolvedCampaignId` (a mis-tagged URL, a stale
// alias). The ad set's id wins: it came from Meta's own data, not an inference.
// We do NOT rewrite `resolvedCampaignId` — the roll-up groups an adset-resolved
// lead under the ad set's campaign (adPerformance already keeps an adset →
// campaign map), so the tree stays internally consistent without destroying the
// record of what the UTM itself resolved to.
//
// An unresolved term/content is a normal outcome, not an error — callers must
// handle `{ adsetId: null, adId: null }`.

const MetaAdset = require('../models/MetaAdset');
const MetaAd = require('../models/MetaAd');
const { normalizeName } = require('./normalizeName');

// Same caching story as campaignResolver: tiny collections, but resolved once
// per lead by the backfill, so indexed in memory with a short TTL — an ad set
// created by the sync minutes ago must start resolving without a restart.
const TTL_MS = Number(process.env.CAMPAIGN_INDEX_TTL_MS || 60000);

let index = null;
let indexedAt = 0;
let loading = null;

/**
 * Meta allows duplicate names, so a name lookup can be ambiguous. Resolve that
 * deterministically: newest row first (these models carry syncedAt timestamps,
 * not createdTime, so `createdAt` is the recency signal), id as the tie-break —
 * the backfill must produce the same answer every run.
 */
function bestFirst(a, b) {
  const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  if (at !== bt) return bt - at; // newest first
  const ai = String(a._id);
  const bi = String(b._id);
  return ai < bi ? 1 : ai > bi ? -1 : 0; // then highest id first
}

async function buildIndex() {
  const [adsets, ads] = await Promise.all([
    MetaAdset.find({}, { name: 1, campaignId: 1, createdAt: 1 }).lean(),
    MetaAd.find({}, { name: 1, adsetId: 1, campaignId: 1, createdAt: 1 }).lean(),
  ]);
  adsets.sort(bestFirst);
  ads.sort(bestFirst);

  const adsetById = new Map(); // id -> {campaignId}
  const adsetByName = new Map(); // verbatim name -> id (newest wins)
  const adsetByNormalized = new Map();
  for (const row of adsets) {
    const id = String(row._id);
    adsetById.set(id, { campaignId: row.campaignId ? String(row.campaignId) : null });
    if (row.name == null) continue;
    const name = String(row.name);
    if (!adsetByName.has(name)) adsetByName.set(name, id);
    const normalized = normalizeName(name);
    if (normalized && !adsetByNormalized.has(normalized)) adsetByNormalized.set(normalized, id);
  }

  const adById = new Map(); // id -> {adsetId}
  const adsByAdset = new Map(); // adsetId -> [{id, name, normalizedName}] bestFirst-sorted
  for (const row of ads) {
    const id = String(row._id);
    const adsetId = row.adsetId ? String(row.adsetId) : null;
    adById.set(id, { adsetId });
    if (!adsetId) continue;
    if (!adsByAdset.has(adsetId)) adsByAdset.set(adsetId, []);
    adsByAdset.get(adsetId).push({
      id,
      name: row.name == null ? null : String(row.name),
      normalizedName: row.name == null ? '' : normalizeName(row.name),
    });
  }

  return { adsetById, adsetByName, adsetByNormalized, adById, adsByAdset };
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
  // Concurrent callers share one query instead of stampeding the collections.
  return loading;
}

/** Drop the cached index — call before a backfill, after a Meta sync. */
function invalidate() {
  index = null;
  indexedAt = 0;
}

const unresolved = () => ({ adsetId: null, adsetBy: null, adId: null, adBy: null });

/**
 * The pure matching, against an already-built index — separated from the cached
 * DB load so the tier ordering is testable without Mongo.
 *
 * @param {{adsetById: Map, adsetByName: Map, adsetByNormalized: Map, adById: Map, adsByAdset: Map}} idx
 * @param {{utmTerm?: string|null, utmContent?: string|null}} lead
 * @returns {{adsetId: string|null, adsetBy: 'id'|'ad-id'|'exact'|'normalized'|null,
 *            adId: string|null, adBy: 'term'|'id'|'exact'|'normalized'|null}}
 */
function resolveWithIndex(idx, { utmTerm, utmContent } = {}) {
  const term = utmTerm == null ? '' : String(utmTerm).trim();
  const content = utmContent == null ? '' : String(utmContent).trim();
  const out = unresolved();
  if (!term && !content) return out;

  // --- utm_term → ad set -----------------------------------------------------
  if (term) {
    if (/^\d+$/.test(term) && idx.adsetById.has(term)) {
      // The tag IS the ad set id — the expected, rename-proof hot path.
      out.adsetId = term;
      out.adsetBy = 'id';
    } else if (/^\d+$/.test(term) && idx.adById.has(term)) {
      // Some URLs tag the AD id instead. That names the ad outright, and the ad
      // set is its parent — both are facts, recorded as such.
      out.adId = term;
      out.adBy = 'term';
      out.adsetId = idx.adById.get(term).adsetId;
      out.adsetBy = out.adsetId ? 'ad-id' : null;
    } else if (idx.adsetByName.has(term)) {
      out.adsetId = idx.adsetByName.get(term);
      out.adsetBy = 'exact';
    } else {
      const normalized = normalizeName(term);
      if (normalized && idx.adsetByNormalized.has(normalized)) {
        out.adsetId = idx.adsetByNormalized.get(normalized);
        out.adsetBy = 'normalized';
      }
    }
  }

  // --- utm_content → ad, scoped to the resolved ad set -----------------------
  // Only once the ad set is known: an ad name matched across ALL ads would let a
  // reused creative name attach a lead to the wrong campaign entirely. No ad set,
  // no ad — the lead stays at whatever level did resolve.
  if (content && out.adsetId && !out.adId) {
    const candidates = idx.adsByAdset.get(out.adsetId) || [];
    if (/^\d+$/.test(content)) {
      const hit = candidates.find((a) => a.id === content);
      if (hit) {
        out.adId = hit.id;
        out.adBy = 'id';
      }
    }
    if (!out.adId) {
      const hit = candidates.find((a) => a.name === content);
      if (hit) {
        out.adId = hit.id;
        out.adBy = 'exact';
      }
    }
    if (!out.adId) {
      const normalized = normalizeName(content);
      if (normalized) {
        const hit = candidates.find((a) => a.normalizedName === normalized);
        if (hit) {
          out.adId = hit.id;
          out.adBy = 'normalized';
        }
      }
    }
  }

  return out;
}

/** Resolve against the cached (TTL) index — the entry point ingest and the backfill use. */
async function resolveAdEntities(lead = {}) {
  return resolveWithIndex(await getIndex(), lead);
}

module.exports = { resolveAdEntities, resolveWithIndex, invalidate };
