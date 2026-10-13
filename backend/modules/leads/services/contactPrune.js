// Drop contacts from our Bigin mirror that no longer exist in Bigin.
//
// The contact webhook only fires on Create / Edit, so a contact deleted in Bigin
// stayed in the mirror forever (and kept counting in the Funnel, Leads, Ad
// Performance …). Once a night the scheduler lists every contact id in Bigin and
// deletes the mirror rows that are not in that list.
//
// SAFETY
// ------
// Deleting on a bad read would wipe real leads, so the prune refuses to act unless:
//   - the Bigin listing completed — every page read, `more_records` ran out;
//   - the listing is not empty;
//   - the rows to delete are at most MAX_PRUNE_SHARE of the mirror (a mass
//     delete is far likelier to be a broken read than real deletes — run the
//     script with --force after checking).
// A row created after the listing started is never deleted: the webhook can add
// a contact the listing paged past.
//
// Only the Contact mirror is touched. Deals and calls stay — they are history.

const Contact = require('../models/Contact');
const { apiGet } = require('../../../services/zoho');
const { invalidateLeadListCache } = require('./leadList');
const { invalidateFunnelCache } = require('./funnel');

const MAX_PAGES = 200; // 40k contacts at 200 a page — Bigin holds ~7k
const MAX_PRUNE_SHARE = Number(process.env.CONTACT_PRUNE_MAX_SHARE || 0.05);

/**
 * Every contact id in Bigin. Throws unless the whole module was read.
 * Resolves `null` when Zoho is not configured.
 */
async function fetchBiginContactIds() {
  const ids = new Set();
  let page = 1;
  let pageToken = null;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const qs = pageToken ? `page_token=${encodeURIComponent(pageToken)}` : `page=${page}`;
    const r = await apiGet(`/Contacts?fields=id&per_page=200&${qs}`);
    if (r.skipped) return null;
    if (!r.ok) throw new Error(r.error || `Contacts page ${page} failed`);

    for (const c of (r.json && r.json.data) || []) if (c && c.id) ids.add(String(c.id));

    const info = (r.json && r.json.info) || {};
    if (!info.more_records) return ids;
    pageToken = info.next_page_token || null;
    page += 1;
  }
  throw new Error(`Contacts listing still had more records after ${MAX_PAGES} pages`);
}

/**
 * The pure decision — no DB, no Zoho.
 *
 * @param {object[]} mirror  [{zohoId, createdAt}] — every mirror row
 * @param {Set<string>} biginIds
 * @param {Date} listedAt    when the Bigin listing started
 * @returns {{ missing: string[], refused: string|null }}
 */
function planPrune(mirror, biginIds, listedAt, { force = false, maxShare = MAX_PRUNE_SHARE } = {}) {
  if (!biginIds.size) return { missing: [], refused: 'Bigin returned no contacts' };

  const missing = mirror
    .filter((c) => !biginIds.has(String(c.zohoId)))
    .filter((c) => !c.createdAt || new Date(c.createdAt) < listedAt)
    .map((c) => String(c.zohoId));

  if (!force && missing.length > Math.max(1, Math.floor(mirror.length * maxShare))) {
    return {
      missing,
      refused:
        `${missing.length} of ${mirror.length} contacts missing from Bigin — over the ` +
        `${Math.round(maxShare * 100)}% safety limit`,
    };
  }
  return { missing, refused: null };
}

/**
 * List Bigin, delete the mirror rows it no longer has.
 * @returns {{ skipped?: true, bigin, mirror, missing, deleted, refused }}
 */
async function pruneDeletedContacts({ dryRun = false, force = false } = {}) {
  const listedAt = new Date();
  const biginIds = await fetchBiginContactIds();
  if (!biginIds) return { skipped: true };

  const mirror = await Contact.find({}, { zohoId: 1, createdAt: 1 }).lean();
  const { missing, refused } = planPrune(mirror, biginIds, listedAt, { force });

  let deleted = 0;
  if (!refused && !dryRun && missing.length) {
    deleted = (await Contact.deleteMany({ zohoId: { $in: missing } })).deletedCount;
    invalidateLeadListCache();
    invalidateFunnelCache();
  }
  return { bigin: biginIds.size, mirror: mirror.length, missing, deleted, refused };
}

module.exports = { pruneDeletedContacts, planPrune, fetchBiginContactIds };
