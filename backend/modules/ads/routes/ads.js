// The admin ads reporting API — everything behind the Marketing and Ad Leads
// tabs. Read-only over the Meta mirror, plus one write: "sync now".
//
// ADMIN ONLY, WITHOUT EXCEPTION
// -----------------------------
// Ad spend, cost per lead and raw lead PII are management data; a sales rep has
// no business with any of it. The gate is applied once, at the router, in the
// same shape `routes/users.js` uses — one `router.use(authenticate, requireAdmin)`
// above every handler, so a route added later cannot be born unprotected.
//
// WHAT THIS FILE DOES NOT DO
// --------------------------
// It computes nothing that a service already computes. Lead counting comes from
// the CPL cache's `leadsFromActions`, so this API and the per-lead cost estimate
// can never disagree about what a "lead" is; syncing is `syncAll`; nothing here
// writes to the mirror.
//
// TWO CURRENCIES, DELIBERATELY UNRECONCILED
// -----------------------------------------
// Insight `spend` is in RUPEES (major units). Campaign/ad-set budgets are in
// PAISE (minor units). That is Meta's split, not ours, and normalising one to the
// other here is precisely how a figure ends up wrong by a factor of a hundred. So
// both are returned exactly as stored, and every response that carries money also
// carries a `units` block naming which is which — the frontend formats from that.

const express = require('express');
const mongoose = require('mongoose');

const MetaInsight = require('../models/MetaInsight');
const MetaCampaign = require('../models/MetaCampaign');
const MetaLead = require('../models/MetaLead');
const WebLead = require('../models/WebLead');
const AdSyncRun = require('../models/AdSyncRun');
const Task = require('../../../models/Task');
const Deal = require('../../calls/models/Deal');

const meta = require('../services/metaClient');
const { syncAll, isSyncing } = require('../services/syncAll');
const cplCache = require('../services/cplCache');
const { phoneFromFieldData } = require('../services/leadLinker');
const { getSourceRollup } = require('../services/sourceRollup');
const { rateLimit } = require('../middleware/rateLimit');
const { authenticate, requireAdmin } = require('../../../middleware/auth');
const campaignAliasRoutes = require('./campaignAliases');

const router = express.Router();

// Every route below. Nothing in this file is reachable without a valid JWT AND
// the admin role — see the file header.
router.use(authenticate, requireAdmin);

// The operator-maintained UTM -> campaign alias table. Mounted HERE, below the
// gate, so it inherits it: that sub-router carries no auth of its own and must
// never be mounted anywhere else. See routes/campaignAliases.js.
router.use('/campaign-aliases', campaignAliasRoutes);

// ---------------------------------------------------------------------------
// Date ranges and insight roll-ups
// ---------------------------------------------------------------------------
//
// All of it lives in services/adMetrics.js, so that the ask-the-data agent can
// answer "what did we spend last month" by running THIS code rather than its own
// version of it. See that file for the local-time rule the dates obey and the
// reason CTR/CPC/CPL are recomputed from summed totals instead of averaged.

const {
  parseRange,
  rangeFilter,
  readMetrics,
  nextDay,
  money,
  rollUp,
  SPEND_UNITS,
  BUDGET_UNITS,
} = require('../services/adMetrics');


const fail = (res, status, message) => res.status(status).json({ success: false, message });

function serverError(res, what, err) {
  console.error(`[ads api] ${what} failed:`, err.message);
  return fail(res, 500, `Failed to ${what}`);
}

// ---------------------------------------------------------------------------
// GET /api/ads/sources — which lead source closed the deal
// ---------------------------------------------------------------------------

/**
 * Closed deals grouped by the channel on their Bigin contact, plus the Meta
 * campaigns behind the ones that came from an ad.
 *
 * The range is OPTIONAL here, unlike every other route in this file, and it
 * means something different. Elsewhere it windows Meta INSIGHT rows, where the
 * mirror only holds a recent slice and a default of "all time" would be a lie
 * about coverage. Here it windows CLOSING DATES in a CRM mirror that goes back
 * to the beginning, so the useful default is the whole history — you cannot
 * judge a channel on 30 days of a business with 184 lifetime sales.
 *
 * A partial range is rejected rather than half-defaulted, for the same reason
 * POST /sync rejects one: silently filling in "…to today" answers a question
 * nobody asked.
 */
router.get('/sources', async (req, res) => {
  const hasFrom = req.query.from != null && req.query.from !== '';
  const hasTo = req.query.to != null && req.query.to !== '';
  if (hasFrom !== hasTo) {
    return fail(res, 400, "Provide both 'from' and 'to', or neither.");
  }

  let range = {};
  if (hasFrom) {
    const parsed = parseRange(req.query);
    if (parsed.error) return fail(res, 400, parsed.error);
    range = parsed;
  }

  try {
    return res.json({ success: true, data: await getSourceRollup(range) });
  } catch (err) {
    return serverError(res, 'load the source breakdown', err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/ads/summary — headline totals
// ---------------------------------------------------------------------------

/**
 * Spend, leads, CPL, impressions, clicks and CTR for a date range.
 *
 * Scoped to CAMPAIGN-level rows, and that is the whole correctness story here.
 * The mirror holds both campaign-level and account-level rows for the same days
 * (the sync pulls each separately so the reconciliation below has something to
 * compare); summing across levels would count every rupee twice. The retired CRM
 * had to state this explicitly too — see its insights.ts summary route.
 */
router.get('/summary', async (req, res) => {
  const range = parseRange(req.query);
  if (range.error) return fail(res, 400, range.error);

  try {
    const rows = await readMetrics({ level: 'campaign', ...rangeFilter(range) });
    const totals = rollUp(rows);

    return res.json({
      success: true,
      data: {
        range,
        ...totals,
        insightRows: rows.length,
        level: 'campaign',
        units: SPEND_UNITS,
      },
    });
  } catch (err) {
    return serverError(res, 'load the ads summary', err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/ads/campaigns — per-campaign performance
// ---------------------------------------------------------------------------

/**
 * One row per campaign that spent anything in the range: spend, impressions,
 * clicks, CTR, CPC, leads, CPL — plus the campaign's own metadata.
 *
 * Only campaigns WITH insight rows in the range appear. A performance table for
 * "last 30 days" listing every campaign ever run, most of them all-zero and long
 * archived, buries the handful that are actually spending money.
 *
 * A campaign id with no row in MetaCampaign (archived at Meta and pruned from
 * our mirror, but still carrying spend in the range) is still returned, with
 * `known: false` and a null name — dropping it would lose its spend from a table
 * that has to add up to the summary.
 */
router.get('/campaigns', async (req, res) => {
  const range = parseRange(req.query);
  if (range.error) return fail(res, 400, range.error);

  try {
    const rows = await readMetrics({ level: 'campaign', ...rangeFilter(range) });

    // Group first, roll up second, so each campaign's totals go through the very
    // same `rollUp` as the summary — one definition of CTR/CPC/CPL, not two.
    const grouped = new Map();
    for (const row of rows) {
      // `campaignId` is nulled by the sync when the parent is not in our mirror;
      // at campaign level `entityId` IS the campaign id, so it is the fallback.
      const campaignId = row.campaignId || row.entityId;
      if (!campaignId || campaignId === 'unknown') continue;
      if (!grouped.has(campaignId)) grouped.set(campaignId, []);
      grouped.get(campaignId).push(row);
    }

    const campaigns = await MetaCampaign.find({ _id: { $in: [...grouped.keys()] } }).lean();
    const byId = new Map(campaigns.map((c) => [String(c._id), c]));

    const data = [...grouped.entries()]
      .map(([campaignId, campaignRows]) => {
        const campaign = byId.get(campaignId);
        return {
          campaignId,
          known: Boolean(campaign),
          name: (campaign && campaign.name) || null,
          objective: (campaign && campaign.objective) || null,
          status: (campaign && campaign.status) || null,
          effectiveStatus: (campaign && campaign.effectiveStatus) || null,
          // Paise. Not converted — see the file header.
          dailyBudget: campaign && campaign.dailyBudget != null ? campaign.dailyBudget : null,
          lifetimeBudget:
            campaign && campaign.lifetimeBudget != null ? campaign.lifetimeBudget : null,
          ...rollUp(campaignRows),
          insightRows: campaignRows.length,
        };
      })
      // Biggest spender first; name as a stable tie-break so two campaigns with
      // identical spend don't swap places between requests.
      .sort((a, b) => b.spend - a.spend || String(a.name).localeCompare(String(b.name)));

    return res.json({
      success: true,
      count: data.length,
      data,
      range,
      units: { ...SPEND_UNITS, ...BUDGET_UNITS },
    });
  } catch (err) {
    return serverError(res, 'load campaign performance', err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/ads/insights — the underlying rows
// ---------------------------------------------------------------------------

const INSIGHT_LEVELS = ['account', 'campaign', 'adset', 'ad'];

/**
 * The stored insight rows behind the numbers above, for drill-down: filterable
 * by range, level and campaign. Returned as stored — this is the "show me the
 * receipts" endpoint, so nothing is derived or reshaped here.
 */
router.get('/insights', async (req, res) => {
  const range = parseRange(req.query);
  if (range.error) return fail(res, 400, range.error);

  const level = req.query.level ? String(req.query.level) : null;
  if (level && !INSIGHT_LEVELS.includes(level)) {
    return fail(res, 400, `Invalid level '${level}'. Expected one of: ${INSIGHT_LEVELS.join(', ')}`);
  }

  const limit = clamp(req.query.limit, 500, 1, 5000);

  try {
    const filter = rangeFilter(range);
    if (level) filter.level = level;
    if (req.query.campaignId) filter.campaignId = String(req.query.campaignId);

    // Hydrated, not lean: the ads models' toJSON transform is what exposes `id`
    // and hides `_id`, and every other ads endpoint answers in that shape.
    const [insights, total] = await Promise.all([
      MetaInsight.find(filter).sort({ dateStart: -1, entityId: 1 }).limit(limit),
      MetaInsight.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      count: insights.length,
      total,
      truncated: total > insights.length,
      data: insights,
      range,
      units: SPEND_UNITS,
    });
  } catch (err) {
    return serverError(res, 'load insights', err);
  }
});

/** A bounded integer query param. */
function clamp(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

// ---------------------------------------------------------------------------
// GET /api/ads/leads — the Ad Leads tab
// ---------------------------------------------------------------------------
//
// Web and Meta leads in one list, each carrying the two facts the tab exists to
// show: which campaign it came from, and whether it reached a Task. The two
// filters are the actionable ones — `unlinked=true` is the list of leads nobody
// is following up, and `unresolved=true` is the list of ads whose UTM tagging is
// broken. Both are worklists, not curiosities: `unresolved` therefore EXCLUDES
// leads an admin already triaged as having no Meta campaign. Those are reachable
// on their own with `unmapped=true`.
//
// AND WHETHER IT CLOSED
// ---------------------
// "Somebody is following this up" is not the question the money asks. Each row
// therefore also carries a `status`, resolved from the Deal mirror first and the
// Task second — see leadStatus() below for the precedence and what each state
// means.

const TASK_FIELDS = { _id: 1, phone: 1, 'body.Who_Id': 1, 'body.Status': 1 };

// Enough of a Deal to say what happened, and nothing more — this list runs up to
// 1,000 rows wide and a Deal carries a products subform.
const DEAL_FIELDS = {
  socialLeadId: 1,
  contactPhoneKey: 1,
  stage: 1,
  outcome: 1,
  amount: 1,
  closingDate: 1,
  modifiedTime: 1,
};

const LEAD_STATES = ['won', 'lost', 'pipeline', 'followup', 'none'];

/** Query-string boolean: `?unlinked=1`, `?unlinked=true` and `?unlinked` are all true. */
function boolParam(raw) {
  if (raw === undefined) return undefined;
  const value = String(raw).toLowerCase();
  if (value === '' || value === '1' || value === 'true' || value === 'yes') return true;
  if (value === '0' || value === 'false' || value === 'no') return false;
  return undefined;
}

// A Meta instant-form answer set is an untyped [{name, values}] list whose field
// names are chosen per form, so a display name has to be looked for under
// several. Display only — the PHONE is deliberately not extracted here but taken
// from leadLinker.phoneFromFieldData, so the number shown is the same 10-digit
// key everything else joins on rather than a second, subtly different normaliser.
const NAME_FIELDS = ['fullname', 'name', 'firstname', 'yourname'];
const EMAIL_FIELDS = ['email', 'emailaddress', 'youremail'];

function fieldValue(fieldData, wanted) {
  if (!Array.isArray(fieldData)) return null;
  for (const want of wanted) {
    for (const entry of fieldData) {
      if (!entry || typeof entry !== 'object') continue;
      const name = String(entry.name == null ? '' : entry.name)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
      if (name !== want) continue;
      const values = Array.isArray(entry.values) ? entry.values : [entry.values];
      const value = values.find((v) => v != null && String(v).trim() !== '');
      if (value != null) return String(value);
    }
  }
  return null;
}

/**
 * Which Meta lead ids can even be looked up against `Task.linkedLeadId`.
 *
 * `MetaLead._id` is Meta's own 16-digit string id while `Task.linkedLeadId` is
 * typed ObjectId, so passing those ids to a query throws a CastError and takes
 * the whole request down. (leadLinker documents the same gap from the other
 * side: today no Meta lead can be linked at all.) Rather than hard-code that,
 * the schema is asked what it accepts — the day `linkedLeadId` is widened to
 * Mixed, Meta links start showing up here with no change to this file.
 */
function linkableIds(ids) {
  const path = Task.schema.path('linkedLeadId');
  const isObjectIdPath = path && path.instance === 'ObjectID';
  if (!isObjectIdPath) return ids;
  return ids.filter(
    (id) =>
      mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === String(id)
  );
}

function taskSummary(task) {
  if (!task) return null;
  const who = (task.body && task.body.Who_Id) || {};
  return { id: String(task._id), name: who.name || null, phone: task.phone || who.phone || null };
}

// A contact can carry several deals. Won beats lost beats open — a lead that lost
// one deal and won another HAS bought — and within a rank the newest wins.
const OUTCOME_RANK = { won: 0, lost: 1, open: 2 };

function bestDeal(a, b) {
  if (!a) return b;
  if (!b) return a;
  const rank = (d) => (OUTCOME_RANK[d.outcome] === undefined ? 3 : OUTCOME_RANK[d.outcome]);
  if (rank(a) !== rank(b)) return rank(a) < rank(b) ? a : b;
  const at = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
  const bt = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
  return bt > at ? b : a;
}

function indexDeals(deals, keyOf) {
  const map = new Map();
  for (const deal of deals) {
    const key = keyOf(deal);
    if (!key) continue;
    map.set(String(key), bestDeal(map.get(String(key)), deal));
  }
  return map;
}

/**
 * What actually happened to this lead.
 *
 * The Deal answers first because it is the commercial fact: a contact with a
 * "Closed with Sale" deal has bought, whatever their follow-up task still says.
 * The Task answers only when no deal exists at all — "somebody is working it".
 *
 *   won      the deal closed with a sale
 *   lost     the deal closed without one
 *   pipeline a deal exists and is still open
 *   followup a follow-up task exists but no deal does
 *   none     nobody has picked this lead up
 *
 * `outcome` is READ, never re-derived from the stage string: dealStore normalised
 * it at write time (outcomeOf), and recomputing here would mean this tab and the
 * Sources tab could disagree about the same deal.
 *
 * `matchedBy` is carried out to the UI because the two joins are not equally
 * strong. 'lead-id' is Meta's own lead id on both sides — a fact. 'phone' is a
 * 10-digit key, which a family or a reused handset can share — an inference. The
 * tab shows the difference rather than flattening a guess into a sale, the same
 * way `resolvedBy` does for campaign attribution.
 */
function leadStatus(task, deal, matchedBy) {
  const taskStatus = (task && task.body && task.body.Status) || null;
  const state = deal
    ? deal.outcome === 'won'
      ? 'won'
      : deal.outcome === 'lost'
        ? 'lost'
        : 'pipeline'
    : task
      ? 'followup'
      : 'none';

  return {
    state,
    stage: deal ? deal.stage || null : null,
    taskStatus,
    amount: deal && deal.outcome === 'won' ? deal.amount || 0 : null,
    closingDate: deal ? deal.closingDate || null : null,
    matchedBy: deal ? matchedBy : null,
  };
}

router.get('/leads', async (req, res) => {
  const range = parseRange(req.query);
  if (range.error) return fail(res, 400, range.error);

  const source = req.query.source ? String(req.query.source).toLowerCase() : null;
  if (source && source !== 'web' && source !== 'meta') {
    return fail(res, 400, `Invalid source '${source}'. Expected 'web' or 'meta'.`);
  }

  // `unlinked=true` and `linked=false` mean the same thing; both are accepted so
  // the tab can spell its filter whichever way reads better.
  const unlinked = boolParam(req.query.unlinked);
  const linkedParam = boolParam(req.query.linked);
  const wantLinked = unlinked === true ? false : unlinked === false ? true : linkedParam;

  const unresolved = boolParam(req.query.unresolved);
  const unmapped = boolParam(req.query.unmapped);
  const campaignId = req.query.campaignId ? String(req.query.campaignId) : null;
  const limit = clamp(req.query.limit, 200, 1, 1000);

  // A status lives in the Deal mirror, which this query does not touch, so like
  // the `linked` filter for Meta rows it can only be applied after the rows are
  // built — i.e. AFTER the per-source cap. Say so in `filters` rather than let a
  // caller read a capped page as a complete answer.
  const status = req.query.status ? String(req.query.status).toLowerCase() : null;
  if (status && !LEAD_STATES.includes(status)) {
    return fail(res, 400, `Invalid status '${status}'. Expected one of ${LEAD_STATES.join(', ')}.`);
  }

  try {
    // Web leads carry a real Date; Meta leads carry Meta's ISO string. Both are
    // bounded by [from 00:00 local, day-after-to 00:00 local) — a half-open
    // interval, so a lead captured at 23:59:59.5 on `to` is included without
    // guessing at millisecond precision. For the string column the same bounds
    // work as a prefix comparison: every ISO timestamp on day D sorts at or
    // after 'D' and strictly before 'D+1'.
    const after = new Date(`${range.from}T00:00:00`);
    const before = new Date(`${nextDay(range.to)}T00:00:00`);

    const webFilter = { createdAt: { $gte: after, $lt: before } };
    if (wantLinked === true) webFilter.linkedTaskId = { $ne: null };
    if (wantLinked === false) webFilter.linkedTaskId = null;
    // `unresolved` is a WORKLIST: UTM strings someone still has to go and fix.
    // A lead an admin already triaged as having no Meta campaign (Google Ads
    // traffic, test data) also has a null `resolvedCampaignId`, so filtering on
    // that column alone hands back a pile of already-answered questions. Ask for
    // them explicitly with `?unmapped=true` instead.
    if (unresolved === true) {
      webFilter.resolvedCampaignId = null;
      webFilter.resolvedBy = { $ne: 'unmapped' };
    }
    if (unresolved === false) webFilter.resolvedCampaignId = { $ne: null };
    if (unmapped === true) webFilter.resolvedBy = 'unmapped';
    if (unmapped === false) webFilter.resolvedBy = { $ne: 'unmapped' };
    if (campaignId) webFilter.resolvedCampaignId = campaignId;

    const metaFilter = { createdTime: { $gte: range.from, $lt: nextDay(range.to) } };
    // A Meta lead's campaign comes from Meta itself, not from a UTM string, so
    // "unresolved" here means the lead arrived with no campaign attached at all.
    if (unresolved === true) metaFilter.campaignId = null;
    if (unresolved === false) metaFilter.campaignId = { $ne: null };
    // Triage is a UTM concept and Meta leads have no UTM, so none of them can be
    // 'unmapped'. Match nothing rather than quietly ignoring the filter and
    // returning every Meta lead alongside the web ones the caller asked for.
    if (unmapped === true) metaFilter._id = null;
    if (campaignId) metaFilter.campaignId = campaignId;

    // Each side is capped at `limit` before merging, so the merged page is the
    // newest `limit` leads overall. NOT a paginated endpoint: an offset across
    // two independently-sorted collections would silently skip rows. `totals`
    // reports how many match in full, so the tab can say "showing 200 of 1,432".
    const [webLeads, metaLeads, webTotal, metaTotal] = await Promise.all([
      source === 'meta'
        ? []
        : WebLead.find(webFilter).sort({ createdAt: -1 }).limit(limit).lean(),
      source === 'web'
        ? []
        : MetaLead.find(metaFilter).sort({ createdTime: -1 }).limit(limit).lean(),
      source === 'meta' ? 0 : WebLead.countDocuments(webFilter),
      source === 'web' ? 0 : MetaLead.countDocuments(metaFilter),
    ]);

    // Resolve campaign names and Task links in two batched lookups rather than
    // one query per lead — this list is up to 1,000 rows wide.
    const campaignIds = new Set();
    for (const lead of webLeads) if (lead.resolvedCampaignId) campaignIds.add(lead.resolvedCampaignId);
    for (const lead of metaLeads) if (lead.campaignId) campaignIds.add(lead.campaignId);

    const webTaskIds = webLeads.map((l) => l.linkedTaskId).filter(Boolean);
    const metaIds = linkableIds(metaLeads.map((l) => l._id));

    // Two ways to reach the sale, batched with the rest.
    //
    // `socialLeadId` is Meta's own lead id, copied onto the deal from the contact
    // by Bigin's LeadChain extension, and a MetaLead's `_id` IS that id — so this
    // half is an id-to-id join with nothing inferred. It is the same hop the
    // Sources tab walks (see sourceRollup.buildMetaRollup).
    //
    // A web lead has no such id, so it falls back to the 10-digit phone key, the
    // join key the whole app already agrees on (Deal.contactPhoneKey is indexed
    // for exactly this). Meta rows use it too, but only where the id found
    // nothing.
    const socialIds = [...new Set(metaLeads.map((l) => String(l._id)))];
    const phoneKeys = [
      ...new Set([...webLeads, ...metaLeads].map((l) => l.phoneKey).filter(Boolean)),
    ];

    const [campaigns, webTasks, metaTasks, dealsById, dealsByPhone] = await Promise.all([
      campaignIds.size
        ? MetaCampaign.find({ _id: { $in: [...campaignIds] } }, { name: 1 }).lean()
        : [],
      webTaskIds.length ? Task.find({ _id: { $in: webTaskIds } }, TASK_FIELDS).lean() : [],
      metaIds.length
        ? Task.find({ leadSource: 'meta', linkedLeadId: { $in: metaIds } },
            { ...TASK_FIELDS, linkedLeadId: 1 }).lean()
        : [],
      socialIds.length ? Deal.find({ socialLeadId: { $in: socialIds } }, DEAL_FIELDS).lean() : [],
      phoneKeys.length
        ? Deal.find({ contactPhoneKey: { $in: phoneKeys } }, DEAL_FIELDS).lean()
        : [],
    ]);

    const campaignName = new Map(campaigns.map((c) => [String(c._id), c.name || null]));
    const taskById = new Map(webTasks.map((t) => [String(t._id), t]));
    const taskByLeadId = new Map(metaTasks.map((t) => [String(t.linkedLeadId), t]));
    const dealByLeadId = indexDeals(dealsById, (d) => d.socialLeadId);
    const dealByPhoneKey = indexDeals(dealsByPhone, (d) => d.contactPhoneKey);

    const rows = [];

    for (const lead of webLeads) {
      const task = lead.linkedTaskId ? taskById.get(String(lead.linkedTaskId)) : null;
      // No id join exists for a web lead — the phone key is the only route to the
      // deal, so a match here is always an inference.
      const deal = lead.phoneKey ? dealByPhoneKey.get(String(lead.phoneKey)) || null : null;
      rows.push({
        id: String(lead._id),
        source: 'web',
        capturedAt: lead.createdAt || null,
        name: lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(' ') || null,
        email: lead.email || null,
        phone: lead.phone || null,
        phoneKey: lead.phoneKey || null,
        form: lead.source || null,
        utm: {
          source: lead.utmSource || null,
          medium: lead.utmMedium || null,
          campaign: lead.utmCampaign || null,
          content: lead.utmContent || null,
          term: lead.utmTerm || null,
        },
        campaignId: lead.resolvedCampaignId || null,
        campaignName: lead.resolvedCampaignId
          ? campaignName.get(String(lead.resolvedCampaignId)) || null
          : null,
        // 'id' | 'exact' | 'normalized' | 'alias' | 'unmapped' — HOW the UTM was
        // matched, so the tab can show whether an attribution is a fact, an
        // inference, or an operator's manual mapping. 'unmapped' carries no
        // campaign on purpose (an admin recorded that this UTM has none). Null
        // means the UTM resolved to nothing and nobody has triaged it.
        resolvedBy: lead.resolvedBy || null,
        linked: Boolean(lead.linkedTaskId),
        task: taskSummary(task),
        status: leadStatus(task, deal, 'phone'),
      });
    }

    for (const lead of metaLeads) {
      const task = taskByLeadId.get(String(lead._id)) || null;
      // The id join first — it is the only one that proves this exact lead is the
      // one that bought. Phone is the fallback for deals whose contact never got
      // a Social Lead ID stamped on it.
      const byId = dealByLeadId.get(String(lead._id)) || null;
      const deal = byId || (lead.phoneKey ? dealByPhoneKey.get(String(lead.phoneKey)) || null : null);
      rows.push({
        id: String(lead._id),
        source: 'meta',
        capturedAt: lead.createdTime || null,
        name: fieldValue(lead.fieldData, NAME_FIELDS),
        email: fieldValue(lead.fieldData, EMAIL_FIELDS),
        // The shared 10-digit join key, from the one extractor that exists.
        phone: lead.phoneKey || phoneFromFieldData(lead.fieldData),
        phoneKey: lead.phoneKey || null,
        form: lead.formId || null,
        utm: null, // an instant-form lead never passed through a landing page
        campaignId: lead.campaignId || null,
        campaignName: lead.campaignId ? campaignName.get(String(lead.campaignId)) || null : null,
        // Not an inference at all: Meta told us the campaign outright.
        resolvedBy: lead.campaignId ? 'meta' : null,
        linked: Boolean(task),
        task: taskSummary(task),
        status: leadStatus(task, deal, byId ? 'lead-id' : 'phone'),
      });
    }

    // A Meta lead's link lives on the Task, not on the lead, so it cannot be
    // filtered in the query above — apply it here instead. Web rows already
    // satisfy the filter and pass through untouched. `status` is the same story
    // for both sources: it comes from the Deal mirror, which the query never saw.
    const filtered = rows.filter(
      (row) =>
        (wantLinked === undefined || row.source !== 'meta' || row.linked === wantLinked) &&
        (status === null || row.status.state === status)
    );

    filtered.sort((a, b) => {
      const at = a.capturedAt ? new Date(a.capturedAt).getTime() : 0;
      const bt = b.capturedAt ? new Date(b.capturedAt).getTime() : 0;
      return bt - at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    });

    const data = filtered.slice(0, limit);

    // The totals need the same correction as the rows: neither the `linked`
    // filter (for Meta) nor `status` (for either source) can be expressed in the
    // query, so the DB counts would over-report. When a side's fetch was not
    // capped, every lead in the range was examined and the surviving count IS the
    // total. Only a capped fetch under a post-build filter leaves it an upper
    // bound — which is what `truncated` is for.
    const survivors = (src) => filtered.reduce((n, row) => n + (row.source === src ? 1 : 0), 0);
    const metaPostFiltered = wantLinked !== undefined || status !== null;
    const metaMatched =
      metaPostFiltered && metaLeads.length === metaTotal ? survivors('meta') : metaTotal;
    const webMatched = status !== null && webLeads.length === webTotal ? survivors('web') : webTotal;

    return res.json({
      success: true,
      count: data.length,
      totals: { web: webMatched, meta: metaMatched, all: webMatched + metaMatched },
      truncated: filtered.length > data.length || webTotal + metaTotal > rows.length,
      range,
      filters: {
        source: source || 'all',
        linked: wantLinked,
        unresolved,
        unmapped,
        campaignId,
        status,
        limit,
      },
      data,
    });
  } catch (err) {
    return serverError(res, 'load ad leads', err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/ads/reconciliation — does the mirror add up?
// ---------------------------------------------------------------------------

/**
 * Meta's ACCOUNT-level spend total for the range against the sum of the
 * CAMPAIGN-level rows for the same range.
 *
 * These are two independent pulls from Meta (the sync fetches each separately),
 * so agreement is evidence the mirror is complete and a gap is a real signal
 * with two plausible causes: spend that isn't attached to any campaign, or a
 * sync that didn't finish. Both numbers and the difference are returned; naming
 * the cause is the UI's job, not this endpoint's — it cannot tell them apart.
 *
 * `difference` is account minus campaigns: positive means Meta billed more than
 * our campaign rows account for.
 */
router.get('/reconciliation', async (req, res) => {
  const range = parseRange(req.query);
  if (range.error) return fail(res, 400, range.error);

  try {
    const filter = rangeFilter(range);
    const [accountRows, campaignRows] = await Promise.all([
      readMetrics({ level: 'account', ...filter }),
      readMetrics({ level: 'campaign', ...filter }),
    ]);

    const account = rollUp(accountRows);
    const campaign = rollUp(campaignRows);
    const difference = money(account.spend - campaign.spend);

    return res.json({
      success: true,
      data: {
        range,
        accountSpend: account.spend,
        campaignSpend: campaign.spend,
        difference,
        accountRows: accountRows.length,
        campaignRows: campaignRows.length,
        // No account-level rows at all is not a zero gap, it is no answer — the
        // UI must say "run a sync", not "reconciled".
        comparable: accountRows.length > 0,
        units: { spend: 'rupees' },
      },
    });
  } catch (err) {
    return serverError(res, 'reconcile spend', err);
  }
});

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

// A full sync hammers the Meta Graph API for tens of days across five resources.
// `isSyncing()` already refuses a concurrent run; this stops an admin leaning on
// the button from queueing up back-to-back runs the moment each one finishes.
const syncLimiter = rateLimit({
  windowMs: 5 * 60_000,
  max: 5,
  message: 'Sync requested too frequently. Please wait a few minutes.',
});

/** GET /api/ads/sync/history — the audit trail, newest first. */
router.get('/sync/history', async (req, res) => {
  const limit = clamp(req.query.limit, 50, 1, 200);
  try {
    const filter = {};
    if (req.query.resource) filter.resource = String(req.query.resource);

    const runs = await AdSyncRun.find(filter).sort({ startedAt: -1 }).limit(limit);

    return res.json({
      success: true,
      count: runs.length,
      data: runs,
      // So the UI can disable "Sync now" while one is in flight instead of
      // offering a button that will only ever answer 409.
      running: isSyncing(),
      configured: meta.isConfigured(),
      cplCache: cplCache.stats(),
    });
  } catch (err) {
    return serverError(res, 'load sync history', err);
  }
});

/**
 * POST /api/ads/sync — start a full sync now.
 *
 * Returns 202 as soon as the run has STARTED, not when it finishes. A full sync
 * runs for minutes; holding the request open would hit every proxy timeout
 * between here and the browser, and the admin would be told it failed while it
 * was in fact still running happily. Progress is read from /sync/history, which
 * is what the AdSyncRun trail is for.
 *
 * The two refusals are both checked BEFORE the run is fired, and there is no
 * `await` between the check and the call. That is what makes the guard sound:
 * `syncAll` flips its in-progress flag synchronously, so on a single-threaded
 * event loop a second request either sees the flag already set (409) or has not
 * started yet. Checking after the fact instead would mean discovering the
 * conflict inside a promise we are no longer allowed to answer from.
 */
router.post('/sync', syncLimiter, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  // A partial range is a caller bug, not a default to be guessed at: syncing
  // "from 1 July to today" when they asked for "1 July to 31 July" would rewrite
  // days they never asked about.
  const hasFrom = body.from != null && body.from !== '';
  const hasTo = body.to != null && body.to !== '';
  if (hasFrom !== hasTo) {
    return fail(res, 400, "Provide both 'from' and 'to', or neither.");
  }

  let range;
  if (hasFrom) {
    const parsed = parseRange(body);
    if (parsed.error) return fail(res, 400, parsed.error);
    range = parsed;
  }

  if (!meta.isConfigured()) {
    return fail(
      res,
      503,
      'Meta is not configured (set META_ACCESS_TOKEN and META_AD_ACCOUNT_ID).'
    );
  }

  if (isSyncing()) {
    return res.status(409).json({
      success: false,
      message: 'A sync is already in progress. Try again once it finishes.',
    });
  }

  const startedAt = new Date();

  // Fired, not awaited — see the doc block. The catch is mandatory: an
  // unhandled rejection out of a detached promise takes the process down, and
  // the failure is already recorded on the AdSyncRun row by `runTracked`.
  syncAll(range).catch((err) => {
    console.warn('[ads api] triggered sync failed:', err.message);
  });

  return res.status(202).json({
    success: true,
    status: 'started',
    startedAt,
    // Echoed so the caller can see what window was actually used; null means
    // syncAll's own default (the last 30 days, computed in local time).
    range: range || null,
    message: 'Sync started. Poll /api/ads/sync/history for progress.',
  });
});

module.exports = router;
