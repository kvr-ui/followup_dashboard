// Admin CRUD for the UTM -> campaign alias table.
//
// GATED BY ITS PARENT, ON PURPOSE
// -------------------------------
// This router carries NO auth of its own. It is mounted inside routes/ads.js,
// below that file's single `router.use(authenticate, requireAdmin)`, so every
// route here inherits exactly the gate the rest of /api/ads has — one gate, in one
// place, rather than a second copy here that can drift from it. The cost of that
// choice is that mounting this router anywhere else would expose ad attribution
// data to any caller, so: it is mounted in exactly one place, and that is the only
// place it may ever be mounted.
//
// WHAT AN ALIAS IS
// ----------------
// An operator's assertion that a raw `utm_campaign` string means a particular Meta
// campaign — or that it means no campaign at all. See models/CampaignAlias for why
// it is data rather than a constant, and services/campaignResolver for why it is
// consulted only after Meta's own data has failed to match.
//
// WHAT THIS FILE DOES NOT DO
// --------------------------
// It does not touch leads. Adding an alias changes what FUTURE resolutions do;
// the leads already in the database keep their stored `resolvedCampaignId` until
// `scripts/resolveLeadCampaigns.js` is re-run. That separation is deliberate — a
// PUT on one row must not quietly rewrite hundreds of lead documents, and the
// backfill is the audited, idempotent, dry-runnable thing that exists to do it.

const express = require('express');

const MetaCampaign = require('../models/MetaCampaign');
const WebLead = require('../models/WebLead');
const aliasStore = require('../services/aliasStore');
const { invalidate: invalidateResolver } = require('../services/campaignResolver');

const router = express.Router();

const fail = (res, status, message) => res.status(status).json({ success: false, message });

function serverError(res, what, err) {
  console.error(`[ads api] ${what} failed:`, err.message);
  return fail(res, 500, `Failed to ${what}`);
}

/** Who is making this change, for the alias's audit fields. */
function actorFrom(req) {
  const user = req.user || {};
  return { id: user._id ? String(user._id) : null, name: user.name || user.username || null };
}

/**
 * Lead counts per distinct `utm_campaign`, keyed by ALIAS KEY.
 *
 * Grouped on the raw string then folded onto the normalized key, because two raw
 * spellings of one campaign are one alias and their counts have to add up — the
 * operator is deciding what to map by how many leads it is worth.
 */
async function leadCounts(match) {
  const rows = await WebLead.aggregate([
    { $match: { utmCampaign: { $nin: [null, ''] }, ...match } },
    { $group: { _id: '$utmCampaign', leads: { $sum: 1 } } },
  ]);

  const byKey = new Map();
  for (const row of rows) {
    const raw = String(row._id);
    const key = aliasStore.keyFor(raw);
    if (!key) continue;
    const entry = byKey.get(key) || { key, leads: 0, spellings: [] };
    entry.leads += row.leads;
    entry.spellings.push({ utmCampaign: raw, leads: row.leads });
    byKey.set(key, entry);
  }
  // Biggest first, key as a stable tie-break so the list does not shuffle between
  // requests when two strings have the same count.
  for (const entry of byKey.values()) {
    entry.spellings.sort((a, b) => b.leads - a.leads || (a.utmCampaign < b.utmCampaign ? -1 : 1));
  }
  return byKey;
}

// ---------------------------------------------------------------------------
// GET /api/ads/campaign-aliases
// ---------------------------------------------------------------------------

/**
 * The aliases, plus the worklist they exist to shrink.
 *
 * `data`       — every alias, mapped and deliberately-unmapped alike, each with
 *                how many leads carry it.
 * `unresolved` — every tagged UTM string that resolved to no campaign AND has no
 *                alias row, ordered by lead count. That ordering is the point:
 *                it says what mapping the next alias is worth, in leads.
 *
 * A deliberately-unmapped UTM is absent from `unresolved` even though its leads
 * have no campaign — it has been triaged, and leaving it on the worklist forever
 * is the problem this table was added to solve.
 */
router.get('/', async (req, res) => {
  try {
    const [aliases, counts, unresolvedCounts] = await Promise.all([
      aliasStore.list(),
      leadCounts({}),
      leadCounts({ resolvedCampaignId: null }),
    ]);

    const campaignIds = aliases.map((a) => a.campaignId).filter(Boolean);
    const campaigns = campaignIds.length
      ? await MetaCampaign.find({ _id: { $in: campaignIds } }, { name: 1 }).lean()
      : [];
    const campaignName = new Map(campaigns.map((c) => [String(c._id), c.name || null]));

    const data = aliases.map((alias) => {
      const key = String(alias._id);
      const count = counts.get(key);
      return {
        key,
        utmCampaign: alias.utmCampaign || null,
        campaignId: alias.campaignId || null,
        campaignName: alias.campaignId ? campaignName.get(String(alias.campaignId)) || null : null,
        // false = the operator triaged this and recorded that no Meta campaign
        // exists for it. Not the same as an alias nobody has written yet.
        mapped: Boolean(alias.campaignId),
        // A mapped alias pointing at a campaign that is no longer in the mirror
        // still resolves; the UI should be able to flag it.
        campaignKnown: alias.campaignId ? campaignName.has(String(alias.campaignId)) : null,
        note: alias.note || null,
        leads: count ? count.leads : 0,
        spellings: count ? count.spellings : [],
        createdBy: alias.createdBy || null,
        updatedBy: alias.updatedBy || null,
        createdAt: alias.createdAt || null,
        updatedAt: alias.updatedAt || null,
      };
    });

    const aliased = new Set(data.map((a) => a.key));
    const unresolved = [...unresolvedCounts.values()]
      .filter((entry) => !aliased.has(entry.key))
      .flatMap((entry) => entry.spellings.map((s) => ({ ...s, key: entry.key })))
      .sort((a, b) => b.leads - a.leads || (a.utmCampaign < b.utmCampaign ? -1 : 1));

    return res.json({
      success: true,
      count: data.length,
      data,
      unresolved,
      unresolvedLeads: unresolved.reduce((n, u) => n + u.leads, 0),
    });
  } catch (err) {
    return serverError(res, 'load campaign aliases', err);
  }
});

// ---------------------------------------------------------------------------
// Write validation
// ---------------------------------------------------------------------------

/**
 * Check the campaign an alias points at actually exists.
 *
 * A typo'd id would otherwise be accepted happily and then attribute leads to a
 * campaign that has no name, no spend and no CPL — an attribution that looks
 * resolved and shows nothing, which is worse than an honest blank. Absent, null
 * and '' all mean "deliberately unmapped" and are legitimate.
 *
 * @returns {Promise<{campaignId: string|null}|{error: string}>}
 */
async function validateCampaignId(raw) {
  if (raw === undefined || raw === null || raw === '') return { campaignId: null };
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return { error: 'campaignId must be a Meta campaign id string, or null for "no campaign".' };
  }
  const campaignId = String(raw).trim();
  if (!campaignId) return { campaignId: null };

  const campaign = await MetaCampaign.findById(campaignId, { _id: 1 }).lean();
  if (!campaign) {
    return { error: `No campaign '${campaignId}' in the mirror. Sync first, or check the id.` };
  }
  return { campaignId };
}

function noteFrom(raw) {
  if (raw === undefined || raw === null) return null;
  const note = String(raw).trim();
  return note === '' ? null : note;
}

/** Everything the API returns about one alias, in one shape for create and update. */
function aliasView(alias) {
  return {
    key: String(alias._id),
    utmCampaign: alias.utmCampaign || null,
    campaignId: alias.campaignId || null,
    mapped: Boolean(alias.campaignId),
    note: alias.note || null,
    createdBy: alias.createdBy || null,
    updatedBy: alias.updatedBy || null,
    createdAt: alias.createdAt || null,
    updatedAt: alias.updatedAt || null,
  };
}

// Every write invalidates the resolver's caches — its campaign index AND the
// alias table's — so an alias added through the UI resolves on the very next
// lead, in this process, without waiting out a TTL.
function afterWrite() {
  invalidateResolver();
}

// ---------------------------------------------------------------------------
// POST /api/ads/campaign-aliases — create (or overwrite) one alias
// ---------------------------------------------------------------------------

/**
 * Body: `{ utmCampaign, campaignId?, note? }`. Omit `campaignId` (or send null)
 * to record "this UTM has no Meta campaign".
 *
 * IDEMPOTENT. The key is derived from `utmCampaign`, so posting the same alias
 * twice is one upsert on one `_id` — the second call reports `created: false` and
 * leaves `createdBy`/`createdAt` alone. That matters because the seed script and
 * an admin clicking twice must not produce two rows for one string.
 */
router.post('/', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  const rawUtm = body.utmCampaign;
  if (rawUtm === undefined || rawUtm === null || String(rawUtm).trim() === '') {
    return fail(res, 400, 'utmCampaign is required.');
  }
  const utmCampaign = String(rawUtm);
  const key = aliasStore.keyFor(utmCampaign);
  if (!key) {
    // Normalisation strips everything but letters and digits, so a UTM of pure
    // punctuation has no key. It could never be looked up, so refuse it here
    // rather than store a row that can never match anything.
    return fail(res, 400, `'${utmCampaign}' has no letters or digits, so it cannot be aliased.`);
  }

  try {
    const campaign = await validateCampaignId(body.campaignId);
    if (campaign.error) return fail(res, 400, campaign.error);

    const { created, alias } = await aliasStore.upsert({
      utmCampaign,
      campaignId: campaign.campaignId,
      note: noteFrom(body.note),
      actor: actorFrom(req),
    });
    afterWrite();

    return res.status(created ? 201 : 200).json({
      success: true,
      created,
      data: aliasView(alias),
      // Said out loud because it is the surprising half: the alias is live for
      // new leads immediately, and historical ones need the backfill.
      message: created
        ? 'Alias created. Re-run scripts/resolveLeadCampaigns.js to apply it to existing leads.'
        : 'Alias already existed and was updated. Re-run scripts/resolveLeadCampaigns.js to apply it to existing leads.',
    });
  } catch (err) {
    return serverError(res, 'save the campaign alias', err);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/ads/campaign-aliases/:key — change what an alias points at
// ---------------------------------------------------------------------------

/**
 * `:key` is the normalized form (as returned by the list endpoint), not the raw
 * UTM string — the raw one may contain spaces and punctuation that a URL path
 * would mangle. The raw string is not editable here: change it and you have a
 * different alias, so POST that one and DELETE this one.
 */
router.put('/:key', async (req, res) => {
  const key = aliasStore.keyFor(req.params.key);
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  try {
    const existing = await aliasStore.get(key);
    if (!existing) return fail(res, 404, `No alias '${req.params.key}'.`);

    const campaign = await validateCampaignId(
      body.campaignId === undefined ? existing.campaignId : body.campaignId
    );
    if (campaign.error) return fail(res, 400, campaign.error);

    const { alias } = await aliasStore.upsert({
      utmCampaign: existing.utmCampaign,
      campaignId: campaign.campaignId,
      note: body.note === undefined ? existing.note : noteFrom(body.note),
      actor: actorFrom(req),
    });
    afterWrite();

    return res.json({
      success: true,
      data: aliasView(alias),
      message: 'Alias updated. Re-run scripts/resolveLeadCampaigns.js to apply it to existing leads.',
    });
  } catch (err) {
    return serverError(res, 'update the campaign alias', err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/ads/campaign-aliases/:key — untriage a UTM string
// ---------------------------------------------------------------------------

/**
 * Puts the string back on the unresolved worklist. The leads it already resolved
 * keep their stored campaign until the backfill is re-run — deleting an alias
 * does not silently un-attribute history behind the operator's back.
 */
router.delete('/:key', async (req, res) => {
  const key = aliasStore.keyFor(req.params.key);
  try {
    const existing = await aliasStore.get(key);
    if (!existing) return fail(res, 404, `No alias '${req.params.key}'.`);

    await aliasStore.remove(key);
    afterWrite();

    // How many leads this alias was speaking for, so the operator knows the size
    // of what they just put back on the worklist.
    const counts = await leadCounts({});
    const affected = counts.get(key);

    return res.json({
      success: true,
      deleted: true,
      data: aliasView(existing),
      leads: affected ? affected.leads : 0,
      message:
        `Alias deleted. ${affected ? affected.leads : 0} lead(s) still carry its stored result; ` +
        're-run scripts/resolveLeadCampaigns.js to clear them.',
    });
  } catch (err) {
    return serverError(res, 'delete the campaign alias', err);
  }
});

module.exports = router;
