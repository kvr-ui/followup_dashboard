// What the ask-the-data agent can actually do.
//
// Every entry is READ-ONLY. Nothing in this file writes to Mongo, to Bigin, or to
// anywhere else — the agent answers questions, it does not change records, and
// the moment that stops being true this comment is the thing that was wrong.
//
// SCOPE IS INJECTED, NEVER ACCEPTED
// ---------------------------------
// No tool takes "whose data" as a parameter that a sales rep could set. The
// dispatcher builds the scope from the authenticated user and hands it to the
// tool; a rep asking the model to "show me everyone's calls" gets their own rows
// back, because the filter is applied below the model, not by it. Tools marked
// `adminOnly` (ad spend, lead contact details, provider billing) are refused
// outright for a rep — they sit behind `requireAdmin` at /api/ads and
// /api/calls/usage, and the agent must not be a way around that gate.
//
// RESULTS ARE SMALL ON PURPOSE
// ----------------------------
// A tool that returns five hundred whole documents does not answer a question, it
// spends the context window. List tools return narrow projections with a hard row
// cap and say when they truncated; transcripts are behind their own tool so a
// call listing doesn't drag a hundred thousand characters along with it.

const Task = require('../../../models/Task');
const Call = require('../../calls/models/Call');
const Deal = require('../../calls/models/Deal');
const ApiUsage = require('../../calls/models/ApiUsage');
const MetaCampaign = require('../../ads/models/MetaCampaign');

const callController = require('../../calls/controllers/callController');
const installmentController = require('../../calls/controllers/installmentController');
const upsellController = require('../../calls/controllers/upsellController');
const usageController = require('../../calls/controllers/usageController');

const { getSourceRollup } = require('../../ads/services/sourceRollup');
const {
  parseRange,
  rangeFilter,
  readMetrics,
  rollUp,
  SPEND_UNITS,
  BUDGET_UNITS,
} = require('../../ads/services/adMetrics');

const zoho = require('../../../services/zoho');
const { invokeController } = require('./invokeController');
const { runAggregation } = require('./mongoQuery');

// How many rows any list tool will ever return. Deliberately smaller than the
// dashboard's own page size: the dashboard is showing a human a table, this is
// feeding a language model that has to reason over the result.
const ROW_CAP = 50;

// Bigin's modules, as reported by /settings/modules on this account. Named
// explicitly so a typo comes back as "unknown module" instead of a 404 the model
// has to interpret.
const BIGIN_MODULES = [
  'Contacts',
  'Accounts',
  'Deals',
  'Tasks',
  'Events',
  'Calls',
  'Products',
  'Notes',
];

// COQL needs the ZohoBigin.coql.READ scope, which the deployed refresh token was
// not minted with — every call comes back "invalid oauth scope to access this
// URL". Rather than ship a tool that always fails, it is off unless an admin has
// re-authorised with that scope and set BIGIN_COQL_ENABLED=1. Until then the
// record/search/fields tools below cover the same ground, one module at a time.
const COQL_ENABLED = process.env.BIGIN_COQL_ENABLED === '1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const clampLimit = (n) => Math.min(Math.max(Number(n) || 20, 1), ROW_CAP);

/** Escape a user/model-supplied string so it is matched literally, not as a pattern. */
const literal = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Wrap a list result so the model can tell "that's all of them" from "that's the
 * first fifty". Without this it will cheerfully report the head of a truncated
 * list as the whole answer.
 */
function listResult(rows, total, limit) {
  return {
    ok: true,
    returned: rows.length,
    matched: total,
    truncated: total > rows.length,
    note:
      total > rows.length
        ? `Showing ${rows.length} of ${total} matching rows. Narrow the filters, or use run_aggregation to COUNT or GROUP instead of listing.`
        : undefined,
    rows,
  };
}

/** Call an existing dashboard handler and unwrap its JSON. */
async function viaController(handler, ctx, query = {}) {
  const { status, body } = await invokeController(handler, { user: ctx.user, query });
  if (status >= 400) {
    return { ok: false, error: (body && body.message) || `Request failed (${status})` };
  }
  // The handlers answer `{success, ...payload}`; drop the flag, keep the payload.
  const { success, ...payload } = body || {};
  return { ok: true, ...payload };
}

/**
 * The owner filter for a Mongo query written in THIS file.
 *
 * Same rule as `ownerScope` in the calls module, restated because the shape here
 * is a scope object rather than a request: an admin may narrow to one rep, a rep
 * is pinned to themselves, and a rep with no mapped address matches nothing
 * rather than everything.
 */
function ownerFilter(ctx, requestedOwner) {
  if (ctx.scope.isAdmin) {
    return requestedOwner ? { ownerEmail: String(requestedOwner).toLowerCase() } : {};
  }
  return { ownerEmail: ctx.scope.ownerEmail || '__no_owner_email__' };
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

const TOOLS = [
  // ── Local data: follow-ups ────────────────────────────────────────────────
  {
    name: 'query_tasks',
    description:
      'List follow-up tasks (one row per contact, from Bigin). Use for "who needs following up", ' +
      '"which leads are untouched", questions about task status or category.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'e.g. "Not Started", "In Progress", "Completed".' },
        category: {
          type: 'string',
          description: 'Bigin Task_Category, e.g. "Follow Up", "Call Back", "Final Follow Up".',
        },
        leadSource: { type: 'string', enum: ['meta', 'web'], description: 'Capture channel.' },
        search: { type: 'string', description: 'Substring match on contact name or phone.' },
        dueBefore: { type: 'string', description: 'YYYY-MM-DD — tasks due on or before this.' },
        dueAfter: { type: 'string', description: 'YYYY-MM-DD — tasks due on or after this.' },
        owner: { type: 'string', description: 'Rep email. Admins only; ignored for a rep.' },
        limit: { type: 'integer', description: `Max rows, up to ${ROW_CAP}. Default 20.` },
      },
    },
    async run(args, ctx) {
      const q = {};
      if (args.status) q['body.Status'] = args.status;
      if (args.category) q.taskCategory = args.category;
      if (args.leadSource) q.leadSource = args.leadSource;
      if (args.dueBefore || args.dueAfter) {
        q['body.Due_Date'] = {};
        if (args.dueAfter) q['body.Due_Date'].$gte = args.dueAfter;
        if (args.dueBefore) q['body.Due_Date'].$lte = args.dueBefore;
      }
      if (args.search) {
        const rx = new RegExp(literal(args.search), 'i');
        q.$or = [{ phone: rx }, { phoneKey: rx }, { 'body.Full_Name': rx }, { 'body.Subject': rx }];
      }
      // Tasks are owned via the raw Bigin payload, whose case is not normalised.
      const owner = ownerFilter(ctx);
      if (owner.ownerEmail) {
        q['body.Owner.email'] = new RegExp(`^${literal(owner.ownerEmail)}$`, 'i');
      }

      const limit = clampLimit(args.limit);
      const [docs, total] = await Promise.all([
        Task.find(q)
          .select('phone phoneKey taskCategory taskCategorySource leadSource body.Subject body.Status body.Due_Date body.Owner body.Full_Name updatedAt')
          .sort({ updatedAt: -1 })
          .limit(limit)
          .lean(),
        Task.countDocuments(q),
      ]);

      const mine = owner.ownerEmail ? String(owner.ownerEmail).toLowerCase() : null;
      const rows = docs.map((d) => {
        // `body` is one task for most contacts and an array for a few — and a
        // contact with several tasks can have them owned by DIFFERENT reps. The
        // query above keeps the document when any one entry matches, so picking
        // element zero would show a scoped rep a colleague's task. Pick theirs.
        let b;
        if (Array.isArray(d.body)) {
          const entries = mine
            ? d.body.filter((e) => String(e?.Owner?.email || '').toLowerCase() === mine)
            : d.body;
          b = entries[0] || {};
        } else {
          b = d.body || {};
        }
        return {
          id: String(d._id),
          contact: b.Full_Name || null,
          phone: d.phone,
          subject: b.Subject || null,
          status: b.Status || null,
          dueDate: b.Due_Date || null,
          category: d.taskCategory,
          categoryInferred: d.taskCategorySource === 'subject',
          leadSource: d.leadSource,
          owner: (b.Owner && b.Owner.email) || null,
          updatedAt: d.updatedAt,
        };
      });
      return listResult(rows, total, limit);
    },
  },

  // ── Local data: calls ─────────────────────────────────────────────────────
  {
    name: 'query_calls',
    description:
      'List calls with their grade score. Transcripts are NOT included — fetch one with ' +
      'get_call_transcript once you know which call you want.',
    parameters: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['won', 'lost', 'open'], description: 'Deal outcome.' },
        direction: { type: 'string', enum: ['inbound', 'outbound', 'unknown'] },
        transcriptionStatus: {
          type: 'string',
          enum: ['pending', 'processing', 'done', 'failed', 'skipped'],
        },
        graded: { type: 'boolean', description: 'true = only calls with a grade score.' },
        minDuration: { type: 'integer', description: 'Seconds.' },
        minScore: { type: 'integer', description: 'Grade score floor, 0-100.' },
        maxScore: { type: 'integer', description: 'Grade score ceiling, 0-100.' },
        from: { type: 'string', description: 'YYYY-MM-DD — calls on or after.' },
        to: { type: 'string', description: 'YYYY-MM-DD — calls on or before.' },
        search: { type: 'string', description: 'Substring on lead name or any phone number.' },
        owner: { type: 'string', description: 'Rep email. Admins only; ignored for a rep.' },
        limit: { type: 'integer', description: `Max rows, up to ${ROW_CAP}. Default 20.` },
      },
    },
    async run(args, ctx) {
      const q = { ...ownerFilter(ctx, args.owner) };
      if (args.outcome) q.outcome = args.outcome;
      if (args.direction) q.direction = args.direction;
      if (args.transcriptionStatus) q.transcriptionStatus = args.transcriptionStatus;
      if (args.graded === true) q['grade.score'] = { $ne: null };
      if (args.graded === false) q['grade.score'] = null;
      if (args.minScore != null || args.maxScore != null) {
        q['grade.score'] = {};
        if (args.minScore != null) q['grade.score'].$gte = Number(args.minScore);
        if (args.maxScore != null) q['grade.score'].$lte = Number(args.maxScore);
      }
      if (args.minDuration) q.duration = { $gte: Number(args.minDuration) };
      if (args.from || args.to) {
        q.startedAt = {};
        if (args.from) q.startedAt.$gte = new Date(`${args.from}T00:00:00`);
        if (args.to) q.startedAt.$lte = new Date(`${args.to}T23:59:59`);
      }
      if (args.search) {
        const rx = new RegExp(literal(args.search), 'i');
        q.$or = [{ leadName: rx }, { leadPhone: rx }, { from: rx }, { to: rx }];
      }

      const limit = clampLimit(args.limit);
      const [docs, total] = await Promise.all([
        Call.find(q)
          .select(
            'startedAt direction duration ownerEmail agentExt leadName leadPhone outcome deal.name deal.amount deal.lostReason transcriptionStatus grade.score grade.summary hasRecording'
          )
          .sort({ startedAt: -1 })
          .limit(limit)
          .lean(),
        Call.countDocuments(q),
      ]);

      const rows = docs.map((c) => ({
        id: String(c._id),
        startedAt: c.startedAt,
        direction: c.direction,
        durationSec: c.duration,
        owner: c.ownerEmail,
        lead: c.leadName,
        phone: c.leadPhone,
        outcome: c.outcome,
        dealName: c.deal && c.deal.name,
        dealAmount: c.deal && c.deal.amount,
        lostReason: c.deal && c.deal.lostReason,
        transcriptionStatus: c.transcriptionStatus,
        score: (c.grade && c.grade.score) != null ? c.grade.score : null,
        gradeSummary: (c.grade && c.grade.summary) || null,
      }));
      return listResult(rows, total, limit);
    },
  },

  {
    name: 'get_call_transcript',
    description:
      'The full transcript and detailed grade for ONE call, by the id returned from query_calls. ' +
      'Transcripts are long, so fetch them one at a time and only when the wording matters.',
    parameters: {
      type: 'object',
      properties: { callId: { type: 'string', description: 'The call id.' } },
      required: ['callId'],
    },
    async run(args, ctx) {
      const call = await Call.findById(args.callId).lean().catch(() => null);
      if (!call) return { ok: false, error: 'No call with that id.' };

      // Same ownership rule getCall enforces: a rep must not read a peer's
      // transcript by guessing an id.
      if (!ctx.scope.isAdmin) {
        const mine = (ctx.scope.ownerEmail || '').toLowerCase();
        if (!mine || (call.ownerEmail || '').toLowerCase() !== mine) {
          return { ok: false, error: 'That call belongs to another rep.' };
        }
      }

      const text = (call.transcript && call.transcript.text) || null;
      // 20k characters is roughly the longest sales call this account produces and
      // still leaves room to reason about it. Say so when it is cut.
      const CAP = 20000;
      return {
        ok: true,
        id: String(call._id),
        startedAt: call.startedAt,
        durationSec: call.duration,
        direction: call.direction,
        owner: call.ownerEmail,
        lead: call.leadName,
        outcome: call.outcome,
        transcriptionStatus: call.transcriptionStatus,
        language: call.transcript && call.transcript.language,
        transcript: text ? text.slice(0, CAP) : null,
        transcriptTruncated: Boolean(text && text.length > CAP),
        grade: call.grade || null,
      };
    },
  },

  // ── Local data: deals ─────────────────────────────────────────────────────
  {
    name: 'query_deals',
    description:
      'List deals — won, lost or open — with amount, lead source, products and the balance still owed.',
    parameters: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['won', 'lost', 'open'] },
        leadSourceKey: { type: 'string', description: 'Canonical channel, e.g. "meta", "referral".' },
        lostReason: { type: 'string' },
        upsoldOnly: { type: 'boolean', description: 'Only deals with Bigin\'s Up_Scale set.' },
        pendingOnly: { type: 'boolean', description: 'Only won deals with a balance still owed.' },
        minAmount: { type: 'number' },
        from: { type: 'string', description: 'YYYY-MM-DD — closing date on or after.' },
        to: { type: 'string', description: 'YYYY-MM-DD — closing date on or before.' },
        search: { type: 'string', description: 'Substring on deal name, contact name or phone.' },
        owner: { type: 'string', description: 'Rep email. Admins only; ignored for a rep.' },
        limit: { type: 'integer', description: `Max rows, up to ${ROW_CAP}. Default 20.` },
      },
    },
    async run(args, ctx) {
      const q = { ...ownerFilter(ctx, args.owner) };
      if (args.outcome) q.outcome = args.outcome;
      if (args.leadSourceKey) q.leadSourceKey = args.leadSourceKey;
      if (args.lostReason) q.lostReason = args.lostReason;
      if (args.upsoldOnly) q.upScale = { $ne: null };
      // `$gt: 0` and not `$ne: null`: 0 is a settled balance, null is one nobody
      // recorded. Neither is money being chased. Same predicate as the
      // Installments tab.
      if (args.pendingOnly) {
        q.outcome = 'won';
        q.installment = { $gt: 0 };
      }
      if (args.minAmount != null) q.amount = { $gte: Number(args.minAmount) };
      if (args.from || args.to) {
        // closingDate is a 'YYYY-MM-DD' string, so string comparison is correct.
        q.closingDate = {};
        if (args.from) q.closingDate.$gte = args.from;
        if (args.to) q.closingDate.$lte = args.to;
      }
      if (args.search) {
        const rx = new RegExp(literal(args.search), 'i');
        q.$or = [{ name: rx }, { contactName: rx }, { contactPhone: rx }];
      }

      const limit = clampLimit(args.limit);
      const [docs, total] = await Promise.all([
        Deal.find(q)
          .select(
            'zohoId name stage outcome closingDate amount installment upScale lostReason ownerEmail ownerName contactName contactPhone leadSource leadSourceKey socialLeadId products'
          )
          .sort({ closingDate: -1 })
          .limit(limit)
          .lean(),
        Deal.countDocuments(q),
      ]);

      const rows = docs.map((d) => ({
        id: d.zohoId,
        name: d.name,
        outcome: d.outcome,
        stage: d.stage,
        closingDate: d.closingDate,
        amount: d.amount,
        pendingBalance: d.installment,
        upsoldTo: d.upScale,
        lostReason: d.lostReason,
        owner: d.ownerEmail,
        contact: d.contactName,
        phone: d.contactPhone,
        leadSource: d.leadSourceKey || d.leadSource,
        metaLeadId: d.socialLeadId,
        products: (d.products || []).map((p) => p.name).filter(Boolean),
      }));
      return listResult(rows, total, limit);
    },
  },

  // ── Local data: the dashboard's own roll-ups ──────────────────────────────
  {
    name: 'call_stats',
    description:
      'Headline call numbers: total, with recording, matched to a lead, graded, and the ' +
      'breakdown by transcription status and by agent. The same figures as the Calls tab.',
    parameters: { type: 'object', properties: {} },
    run: (args, ctx) => viaController(callController.callStats, ctx),
  },

  {
    name: 'deal_outcomes',
    description:
      'Won/lost totals, win rate, revenue, loss reasons, per-rep split, what sold, and upsells. ' +
      'The same figures as the Analytics tab. Start here for any "how are we doing" question.',
    parameters: { type: 'object', properties: {} },
    run: (args, ctx) => viaController(callController.outcomeStats, ctx),
  },

  {
    name: 'grade_analytics',
    description:
      'AI call-grading analytics: score distribution, per-rep averages, trend, and the ' +
      'strongest and weakest calls. The same figures as the Scorecard tab.',
    parameters: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['won', 'lost', 'open'], description: 'Narrow to one outcome.' },
        period: { type: 'string', description: 'Period the tab supports, e.g. "30d", "all".' },
        owner: { type: 'string', description: 'Rep email. Admins only; ignored for a rep.' },
      },
    },
    run: (args, ctx) =>
      viaController(callController.gradeAnalytics, ctx, {
        ...(args.outcome ? { outcome: args.outcome } : {}),
        ...(args.period ? { period: args.period } : {}),
        ...(args.owner ? { owner: args.owner } : {}),
      }),
  },

  {
    name: 'list_installments',
    description:
      'Won deals the customer is still paying off, oldest closing date first, with the ' +
      'outstanding balance. The same list as the Installments tab.',
    parameters: { type: 'object', properties: {} },
    run: (args, ctx) => viaController(installmentController.listInstallments, ctx),
  },

  {
    name: 'list_upsells',
    description: 'Deals upsold to a bigger course, via Bigin\'s Up_Scale field. The Upsells tab.',
    parameters: { type: 'object', properties: {} },
    run: (args, ctx) => viaController(upsellController.listUpsells, ctx),
  },

  // ── Admin only: ad spend and attribution ──────────────────────────────────
  {
    name: 'ad_summary',
    description:
      'Meta ad spend, leads, cost per lead, impressions, clicks and CTR for a date range. ' +
      'Campaign-level rows only, so the totals never double-count. ADMIN ONLY.',
    adminOnly: true,
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD. Defaults to 30 days ago.' },
        to: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
      },
    },
    async run(args) {
      const range = parseRange(args);
      if (range.error) return { ok: false, error: range.error };
      const rows = await readMetrics({ level: 'campaign', ...rangeFilter(range) });
      return { ok: true, range, ...rollUp(rows), insightRows: rows.length, units: SPEND_UNITS };
    },
  },

  {
    name: 'ad_campaigns',
    description:
      'Per-campaign Meta performance for a date range: spend, leads, CPL, CTR, CPC, budgets. ' +
      'Only campaigns that spent something in the range. ADMIN ONLY.',
    adminOnly: true,
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD. Defaults to 30 days ago.' },
        to: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
        limit: { type: 'integer', description: `Top N by spend, up to ${ROW_CAP}. Default 20.` },
      },
    },
    async run(args) {
      const range = parseRange(args);
      if (range.error) return { ok: false, error: range.error };

      const rows = await readMetrics({ level: 'campaign', ...rangeFilter(range) });

      // Grouped then rolled up, so each campaign's CTR/CPC/CPL comes out of the
      // very same `rollUp` the summary uses — one definition, not two.
      const grouped = new Map();
      for (const row of rows) {
        const campaignId = row.campaignId || row.entityId;
        if (!campaignId || campaignId === 'unknown') continue;
        if (!grouped.has(campaignId)) grouped.set(campaignId, []);
        grouped.get(campaignId).push(row);
      }

      const campaigns = await MetaCampaign.find({ _id: { $in: [...grouped.keys()] } }).lean();
      const byId = new Map(campaigns.map((c) => [String(c._id), c]));

      const all = [...grouped.entries()]
        .map(([campaignId, campaignRows]) => {
          const c = byId.get(campaignId);
          return {
            campaignId,
            name: (c && c.name) || null,
            // An archived campaign pruned from the mirror still carried spend, so
            // it stays in the table rather than quietly leaving the total short.
            known: Boolean(c),
            status: (c && c.effectiveStatus) || null,
            dailyBudget: c && c.dailyBudget != null ? c.dailyBudget : null,
            ...rollUp(campaignRows),
          };
        })
        .sort((a, b) => b.spend - a.spend);

      const limit = clampLimit(args.limit);
      return {
        ok: true,
        range,
        returned: Math.min(all.length, limit),
        matched: all.length,
        truncated: all.length > limit,
        units: { ...SPEND_UNITS, ...BUDGET_UNITS },
        campaigns: all.slice(0, limit),
      };
    },
  },

  {
    name: 'source_rollup',
    description:
      'Closed deals grouped by the lead source on their Bigin contact, plus the Meta campaigns ' +
      'behind the paid ones with revenue, ROAS and cost per acquisition. This is the tool for ' +
      '"which channel actually closes" and "did that campaign pay for itself". ADMIN ONLY.',
    adminOnly: true,
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD closing date. Omit BOTH for all time.' },
        to: { type: 'string', description: 'YYYY-MM-DD closing date. Omit BOTH for all time.' },
      },
    },
    async run(args) {
      const hasFrom = args.from != null && args.from !== '';
      const hasTo = args.to != null && args.to !== '';
      if (hasFrom !== hasTo) {
        return { ok: false, error: "Provide both 'from' and 'to', or neither." };
      }
      let range = {};
      if (hasFrom) {
        const parsed = parseRange(args);
        if (parsed.error) return { ok: false, error: parsed.error };
        range = parsed;
      }
      return { ok: true, ...(await getSourceRollup(range)) };
    },
  },

  {
    name: 'ai_usage',
    description:
      'What the AI providers have cost: Sarvam grading tokens, ElevenLabs transcription minutes, ' +
      'OpenAI agent tokens, and any remaining balance. ADMIN ONLY.',
    adminOnly: true,
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Days of history, 7-90. Default 30.' },
      },
    },
    run: (args, ctx) =>
      viaController(usageController.apiUsage, ctx, args.days ? { days: String(args.days) } : {}),
  },

  // ── Live Bigin ────────────────────────────────────────────────────────────
  //
  // ADMIN ONLY, ALL OF THEM, AND NOT FOR THE USUAL REASON
  //
  // These are not admin tools because Bigin holds management data — they are
  // admin tools because Bigin has no owner filter we can impose from here. Every
  // other tool pins a rep to their own rows before the query runs; a live search
  // takes a criteria expression the MODEL wrote, against a CRM that will happily
  // return any record in the org. Composing an owner clause into someone else's
  // criteria string is exactly the kind of guard that works until the day a
  // parenthesis lands wrong, and the failure mode is a rep reading a colleague's
  // book.
  //
  // A rep loses nothing: their tasks, calls and deals are all in the mirror, all
  // carrying ownerEmail, and all reachable through the scoped tools above.
  {
    name: 'bigin_search',
    adminOnly: true,
    description:
      'Search Bigin LIVE, for data newer than the local mirror or fields we do not copy. ' +
      'Criteria syntax: (Field:equals:value), (Field:starts_with:value), (Field:contains:value); ' +
      'combine with and/or, e.g. ((Last_Name:equals:Kumar)and(City:equals:Chennai)). ' +
      'Prefer the local tools when the mirror already holds the answer — this is a network call ' +
      'against a rate-limited API.',
    parameters: {
      type: 'object',
      properties: {
        module: { type: 'string', enum: BIGIN_MODULES },
        criteria: { type: 'string', description: 'A Bigin criteria expression, as above.' },
        limit: { type: 'integer', description: `Max records, up to ${ROW_CAP}. Default 20.` },
      },
      required: ['module', 'criteria'],
    },
    async run(args) {
      if (!BIGIN_MODULES.includes(args.module)) {
        return { ok: false, error: `Unknown Bigin module. Try one of: ${BIGIN_MODULES.join(', ')}.` };
      }
      const limit = clampLimit(args.limit);
      const res = await zoho.apiGet(
        `/${args.module}/search?criteria=${encodeURIComponent(args.criteria)}&per_page=${limit}`
      );
      if (res.skipped) return { ok: false, error: 'Bigin is not configured on this server.' };
      if (!res.ok) return { ok: false, error: `Bigin: ${res.error}` };
      const rows = (res.json && res.json.data) || [];
      return { ok: true, module: args.module, returned: rows.length, rows: rows.slice(0, limit) };
    },
  },

  {
    name: 'bigin_get_record',
    adminOnly: true,
    description:
      'Fetch ONE Bigin record by id, with every field including the custom ones. Use after ' +
      'bigin_search, or with an id from the local mirror (deals.zohoId, tasks.zohoId, ' +
      'deals.contactId).',
    parameters: {
      type: 'object',
      properties: {
        module: { type: 'string', enum: BIGIN_MODULES },
        id: { type: 'string', description: 'The Bigin record id.' },
      },
      required: ['module', 'id'],
    },
    async run(args) {
      if (!BIGIN_MODULES.includes(args.module)) {
        return { ok: false, error: `Unknown Bigin module. Try one of: ${BIGIN_MODULES.join(', ')}.` };
      }
      const res = await zoho.apiGet(`/${args.module}/${encodeURIComponent(args.id)}`);
      if (res.skipped) return { ok: false, error: 'Bigin is not configured on this server.' };
      if (!res.ok) return { ok: false, error: `Bigin: ${res.error}` };
      const record = res.json && res.json.data && res.json.data[0];
      if (!record) return { ok: false, error: 'No such record.' };
      return { ok: true, module: args.module, record };
    },
  },

  {
    name: 'bigin_list_fields',
    adminOnly: true,
    description:
      'The field API names on a Bigin module. This account carries custom fields (Lead_Source1, ' +
      'Up_Scale, Installment, Task_Category, Reasons …), so check here before guessing a field ' +
      'name in a bigin_search criteria expression.',
    parameters: {
      type: 'object',
      properties: { module: { type: 'string', enum: BIGIN_MODULES } },
      required: ['module'],
    },
    async run(args) {
      if (!BIGIN_MODULES.includes(args.module)) {
        return { ok: false, error: `Unknown Bigin module. Try one of: ${BIGIN_MODULES.join(', ')}.` };
      }
      const res = await zoho.apiGet(`/settings/fields?module=${encodeURIComponent(args.module)}`);
      if (res.skipped) return { ok: false, error: 'Bigin is not configured on this server.' };
      if (!res.ok) return { ok: false, error: `Bigin: ${res.error}` };
      const fields = ((res.json && res.json.fields) || []).map((f) => ({
        apiName: f.api_name,
        label: f.field_label,
        type: f.data_type,
        // Picklists are the useful half: knowing the exact spelling of a stage or a
        // loss reason is usually the whole question.
        options: (f.pick_list_values || []).map((p) => p.display_value).slice(0, 40) || undefined,
      }));
      return { ok: true, module: args.module, fields };
    },
  },

  // ── The escape hatch ──────────────────────────────────────────────────────
  {
    name: 'run_aggregation',
    description:
      'Run a read-only MongoDB aggregation when no other tool fits — cross-collection joins, ' +
      'unusual groupings, "who has X but not Y". Writes and server-side JavaScript are rejected. ' +
      'Prefer $group and $count over listing rows. See the schema reference in your instructions ' +
      'for collections and field meanings.',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'One of the collections in the schema reference.' },
        pipeline: {
          type: 'array',
          items: { type: 'object' },
          description: 'The aggregation pipeline, as an array of stages.',
        },
      },
      required: ['collection', 'pipeline'],
    },
    run: (args, ctx) => runAggregation(args, ctx.scope),
  },
];

if (COQL_ENABLED) {
  TOOLS.push({
    name: 'bigin_coql',
    // Same reasoning as the other live-Bigin tools above: no owner filter can be
    // imposed on a statement the model wrote.
    adminOnly: true,
    description:
      'Run a Bigin COQL SELECT against the live CRM. SELECT only. ' +
      'Example: select id, Deal_Name, Amount from Deals where Stage = \'Closed Won\' limit 50.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A COQL SELECT statement.' } },
      required: ['query'],
    },
    async run(args) {
      const q = String(args.query || '').trim();
      // SELECT or nothing. Zoho exposes no write verb on this endpoint, but the
      // refusal is here rather than assumed — this is the one tool where the model
      // hands the CRM a statement it wrote itself.
      if (!/^select\s/i.test(q)) return { ok: false, error: 'Only SELECT statements are allowed.' };
      if (/;/.test(q)) return { ok: false, error: 'Only one statement at a time.' };
      const limited = /\blimit\s+\d+/i.test(q) ? q : `${q} limit 200`;
      const res = await zoho.coql(limited);
      if (res.skipped) return { ok: false, error: 'Bigin is not configured on this server.' };
      if (!res.ok) return { ok: false, error: `Bigin: ${res.error}` };
      return { ok: true, query: limited, returned: res.rows.length, rows: res.rows };
    },
  });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** The tool definitions to advertise to the model, filtered to what this user may use. */
function toolSchemas(scope) {
  return TOOLS.filter((t) => scope.isAdmin || !t.adminOnly).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * Run one tool call.
 *
 * Never throws: a tool that fails comes back as `{ok: false, error}` so the model
 * can say what went wrong or try another route, instead of the whole conversation
 * dying on a bad argument.
 */
async function dispatch(name, args, ctx) {
  const tool = BY_NAME.get(name);
  if (!tool) return { ok: false, error: `No such tool: ${name}` };

  if (tool.adminOnly && !ctx.scope.isAdmin) {
    return {
      ok: false,
      error:
        'That data (ad spend, lead contact details and provider billing) is admin-only. Tell the user you do not have access to it rather than estimating.',
    };
  }

  try {
    const result = await tool.run(args || {}, ctx);
    return result == null ? { ok: false, error: 'The tool returned nothing.' } : result;
  } catch (err) {
    console.error(`[agent] tool ${name} failed:`, err.message);
    return { ok: false, error: `${name} failed: ${err.message}` };
  }
}

module.exports = { TOOLS, toolSchemas, dispatch, ROW_CAP };
