// The VSL tracking API: who watched the video, for how long, and whose lead it is.
//
// THE JOIN IS ACROSS TWO CLUSTERS, SO IT IS EXPLICIT
// -------------------------------------------------
// vsl_leads lives on the VSL project's Atlas cluster; tasks and deals live on
// ours. There is no $lookup that spans them, so this is a two-phase join through
// in-memory maps — the same shape modules/ads/routes/ads.js uses for its lead
// list: batched lookups, never one query per row.
//
// WHY THE VSL SIDE IS BOUNDED BY DATE AND NOT BY PHONE
// ---------------------------------------------------
// vsl_leads.phone is country-code prefixed and we hold only the last 10 digits,
// so a phone filter would have to be a suffix match, which cannot use that
// collection's phone_unique index. The date range IS the server-side bound; the
// owner match is then a map lookup per row.

const Deal = require('../../calls/models/Deal');
const { parseRange, nextDay } = require('../../ads/services/adMetrics');
const { phoneKey } = require('../../../utils/phone');
const { isConfigured, DB_NAME } = require('../services/connection');
const { getPeakMap, stats: watchStats } = require('../services/watchIndex');
const { getTaskIndex, newestOf } = require('../services/taskIndex');
const {
  shapeWatch,
  engagementOf,
  resolveLeadSource,
  indexDeals,
  LEAD_FIELDS,
} = require('../services/vslView');

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 500;

/**
 * Who this request may see.
 *
 * Mirrors callController's ownerScope INCLUDING its sentinel: an admin may
 * narrow with ?owner=, a non-admin is HARD-PINNED to their own ownerEmail
 * whatever they put in the query string, and a rep with no ownerEmail gets a
 * value that matches nothing — so a misconfigured account sees zero leads rather
 * than every unowned one. Returns a mode rather than a Mongo filter because the
 * owner test happens in JS against the task index (see services/taskIndex.js).
 */
function vslOwnerScope(req) {
  if (req.user && req.user.role === 'admin') {
    return {
      mode: 'admin',
      ownerEmail: req.query.owner ? String(req.query.owner).toLowerCase() : null,
    };
  }
  const mine = ((req.user && req.user.ownerEmail) || '').toLowerCase();
  return { mode: 'rep', ownerEmail: mine || '__no_owner_email__' };
}

/** GET /api/vsl/leads — every VSL lead in the range, with its watch time. */
async function listVslLeads(req, res) {
  try {
    if (!isConfigured()) {
      // Not an error: the dashboard runs perfectly well without a VSL cluster.
      // The tab explains itself rather than showing a failure banner.
      return res.json({
        success: true,
        configured: false,
        count: 0,
        truncated: false,
        totals: {},
        data: [],
      });
    }

    const range = parseRange(req.query);
    if (range.error) return res.status(400).json({ success: false, message: range.error });

    const VslLead = require('../models/VslLead')();
    if (!VslLead) {
      return res.json({ success: true, configured: false, count: 0, truncated: false, totals: {}, data: [] });
    }

    const scope = vslOwnerScope(req);
    const limit = Math.min(Number(req.query.limit) || DEFAULT_LIMIT, MAX_LIMIT);

    const [peaks, leads, taskIdx] = await Promise.all([
      getPeakMap(),
      VslLead.find(
        { createdAt: { $gte: new Date(`${range.from}T00:00:00`), $lt: new Date(`${nextDay(range.to)}T00:00:00`) } },
        LEAD_FIELDS
      )
        .sort({ lastActivityAt: -1, createdAt: -1 })
        .limit(MAX_LIMIT + 1)
        .lean(),
      getTaskIndex(),
    ]);

    // ---- Phase 1: scope, and attach the dashboard side -------------------
    // The owner test drops the row entirely rather than blanking it. That is
    // what makes "a rep never sees a lead who isn't in their book" structural
    // rather than a thing the UI remembers to hide.
    const scoped = [];
    for (const lead of leads) {
      const pk = phoneKey(lead.phone);
      const rows = pk ? taskIdx.get(pk) || [] : [];

      if (scope.ownerEmail) {
        const mine = rows.some((row) => row.ownerEmails.includes(scope.ownerEmail));
        if (!mine) continue;
      }

      scoped.push({ lead, pk, taskRow: newestOf(rows), linked: rows.length > 0 });
    }

    // ---- Phase 2: one batched deal lookup, for the scoped rows only ------
    // After the scope filter on purpose: a rep's $in is then their own book
    // rather than the whole company's. contactPhoneKey is indexed.
    const keys = [...new Set(scoped.map((row) => row.pk).filter(Boolean))];
    const deals = keys.length
      ? await Deal.find(
          { contactPhoneKey: { $in: keys } },
          { contactPhoneKey: 1, leadSource: 1, leadSourceKey: 1, outcome: 1, modifiedTime: 1 }
        ).lean()
      : [];
    const dealByKey = indexDeals(deals);

    const rows = scoped.map(({ lead, pk, taskRow, linked }) => {
      const watch = shapeWatch(lead, peaks.get(lead.leadId) || null);
      const deal = pk ? dealByKey.get(pk) || null : null;
      return {
        leadId: lead.leadId,
        phone: lead.phone || null,
        phoneKey: pk,
        name: lead.name || null,
        source: lead.source || null,
        createdAt: lead.createdAt || null,
        linkSentAt: lead.linkSentAt || null,
        linkSendStatus: lead.linkSendStatus || null,
        firstOpenedAt: lead.firstOpenedAt || null,
        lastOpenedAt: lead.lastOpenedAt || null,
        openCount: lead.openCount || 0,
        firstPlayAt: lead.firstPlayAt || null,
        lastActivityAt: lead.lastActivityAt || null,
        lastEventType: lead.lastEventType || null,
        reminderState: lead.reminderState || null,
        watch,
        engagement: engagementOf(lead, watch),
        leadSource: resolveLeadSource(deal, taskRow),
        dealOutcome: deal ? deal.outcome || null : null,
        // Null, not an object of nulls, when nobody is following this person up.
        dashboard: linked && taskRow
          ? {
              linked: true,
              taskId: taskRow.taskId,
              contactName: taskRow.contactName,
              ownerName: taskRow.ownerName,
              // Feeds the tab's owner dropdown. An admin already sees this on
              // Installments and Ad Leads; a rep only ever receives their own.
              ownerEmail: taskRow.ownerEmails[0] || null,
              status: taskRow.status,
            }
          : null,
      };
    });

    // Totals are computed over the SCOPED set, before the optional filters
    // below, so the summary cards keep showing the whole picture while the table
    // narrows. `unjoinable` is counted, not hidden: a number too short to match
    // is a data problem somebody should see.
    const totals = {
      all: rows.length,
      watched: rows.filter((r) => r.engagement === 'watched').length,
      played: rows.filter((r) => r.engagement === 'watched' || r.engagement === 'played').length,
      opened: rows.filter((r) => r.firstOpenedAt || r.openCount > 0).length,
      sent: rows.filter((r) => r.linkSentAt).length,
      notInDashboard: rows.filter((r) => !r.dashboard).length,
      unjoinable: rows.filter((r) => !r.phoneKey).length,
      minutesTotal: Math.round(rows.reduce((sum, r) => sum + r.watch.minutes, 0) * 10) / 10,
    };

    // Optional server-side narrowing, for API callers. The tab filters the
    // fetched range in the browser instead, so its counts stay exact and
    // switching a filter costs no round trip.
    let out = rows;
    const engagement = req.query.engagement;
    if (engagement && engagement !== 'all') {
      out = out.filter((r) =>
        engagement === 'played'
          ? r.engagement === 'played' || r.engagement === 'watched'
          : r.engagement === engagement
      );
    }
    const linked = req.query.linked;
    if (linked === 'linked') out = out.filter((r) => r.dashboard);
    // Always empty for a rep by construction — answered, not rejected.
    else if (linked === 'unlinked') out = out.filter((r) => !r.dashboard);

    if (req.query.search) {
      const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      out = out.filter(
        (r) =>
          rx.test(r.name || '') ||
          rx.test(r.phone || '') ||
          rx.test((r.dashboard && r.dashboard.contactName) || '')
      );
    }

    const truncated = out.length > limit;
    res.json({
      success: true,
      configured: true,
      count: out.length,
      truncated,
      totals,
      data: truncated ? out.slice(0, limit) : out,
    });
  } catch (err) {
    console.error('List VSL leads failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load VSL watch data' });
  }
}

/** GET /api/vsl/status — is the VSL cluster wired up, and is the map warm? */
async function vslStatus(req, res) {
  const configured = isConfigured();
  const body = { success: true, configured };
  if (configured) {
    body.db = DB_NAME;
    // Collection sizes are account-wide diagnostics. Omitted — not nulled — for
    // a rep, so there is nothing in the raw response to find.
    if (req.user && req.user.role === 'admin') body.peaks = watchStats();
  }
  res.json(body);
}

module.exports = { listVslLeads, vslStatus, vslOwnerScope };
