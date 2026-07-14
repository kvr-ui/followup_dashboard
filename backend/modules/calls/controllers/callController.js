const Call = require('../models/Call');
const Deal = require('../models/Deal');
const telecmi = require('../services/telecmi');
const audio = require('../services/audio');
const { agentMap, buildLeadIndex, upsertCall } = require('../services/callStore');
const { getJourneys } = require('../services/journeyCache');

const MIN_DURATION = Number(process.env.TELECMI_MIN_DURATION_SEC || 30);

// Guards against two concurrent POST /api/calls/sync runs processing the same
// TeleCMI window at once (idempotent on cmiuid, so not corrupting — just wasteful).
let syncRunning = false;

/** GET /api/calls — list with filters (admin only). */
async function listCalls(req, res) {
  try {
    const {
      agent,
      owner,
      status,
      leadId,
      search,
      from,
      to,
      minDuration,
      page = 1,
      limit = 50,
    } = req.query;

    const q = {};
    if (agent) q.agentExt = agent;
    if (owner) q.ownerEmail = owner.toLowerCase();
    if (status) q.transcriptionStatus = status;
    if (leadId) q.leadId = leadId;
    if (minDuration) q.duration = { $gte: Number(minDuration) };
    if (from || to) {
      q.startedAt = {};
      if (from) q.startedAt.$gte = new Date(from);
      if (to) q.startedAt.$lte = new Date(`${to}T23:59:59`);
    }
    if (search) {
      const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      q.$or = [{ leadName: rx }, { leadPhone: rx }, { from: rx }, { to: rx }];
    }

    const perPage = Math.min(Number(limit) || 50, 200);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * perPage;

    const [rows, total] = await Promise.all([
      Call.find(q).sort({ startedAt: -1 }).skip(skip).limit(perPage).lean(),
      Call.countDocuments(q),
    ]);

    res.json({ success: true, count: total, page: Number(page) || 1, data: rows });
  } catch (err) {
    console.error('List calls failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to list calls' });
  }
}

/** GET /api/calls/stats — headline numbers for the admin view. */
async function callStats(req, res) {
  try {
    const [total, withRec, byStatus, byAgent, graded] = await Promise.all([
      Call.countDocuments({}),
      Call.countDocuments({ hasRecording: true }),
      Call.aggregate([{ $group: { _id: '$transcriptionStatus', n: { $sum: 1 } } }]),
      Call.aggregate([
        { $group: { _id: '$agentExt', n: { $sum: 1 }, mins: { $sum: '$duration' } } },
        { $sort: { n: -1 } },
      ]),
      Call.countDocuments({ 'grade.score': { $ne: null } }),
    ]);
    const matched = await Call.countDocuments({ leadId: { $ne: null } });

    res.json({
      success: true,
      total,
      withRecording: withRec,
      matchedToLead: matched,
      graded,
      byStatus: byStatus.reduce((a, s) => ({ ...a, [s._id]: s.n }), {}),
      byAgent: byAgent.map((a) => ({
        agentExt: a._id,
        calls: a.n,
        minutes: Math.round(a.mins / 60),
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to build call stats' });
  }
}

/**
/**
 * GET /api/calls/journeys — closed leads, with all their calls attached.
 * A sale is a journey of several calls, so this is the primary admin view.
 *
 * Covers WON and LOST — the whole point of the module is comparing the two.
 * `?outcome=won|lost` narrows it; omit for both.
 *
 * Served from an in-memory snapshot (journeyCache), filtered and paged in JS.
 * Hitting Mongo per request meant a fresh 2,700-deal join on every page click.
 */
async function listJourneys(req, res) {
  try {
    const {
      owner, search, outcome, reason, upsold,
      from, to,                       // deal closing date
      status, minDuration, minCalls, hasCalls, // call-level
      page = 1, limit = 50,
    } = req.query;

    const all = await getJourneys();

    const rx = search
      ? new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      : null;
    const lcOwner = owner ? owner.toLowerCase() : null;

    const filtered = all.filter((j) => {
      // ---- deal-level
      if (outcome === 'won' || outcome === 'lost') {
        if (j.outcome !== outcome) return false;
      }
      if (lcOwner && (j.ownerEmail || '').toLowerCase() !== lcOwner) return false;
      if (reason && j.lostReason !== reason) return false;

      // Upsold = Bigin's Up_Scale picklist is set. With 159 won deals across 4 pages,
      // hunting for the badge by eye isn't a feature — this is.
      if (upsold === 'yes' && !j.upScale) return false;
      if (upsold === 'no' && j.upScale) return false;

      // closingDate is "YYYY-MM-DD", so string compare is correct here.
      if (from && !(j.closingDate && j.closingDate >= from)) return false;
      if (to && !(j.closingDate && j.closingDate <= to)) return false;

      if (rx && !(rx.test(j.contactName || '') || rx.test(j.phone || '') || rx.test(j.deal?.name || ''))) {
        return false;
      }

      // ---- call-level: these describe ONE call, so they select journeys that
      // CONTAIN a matching call rather than hiding the lead's other calls.
      if (minDuration && !(Number(j.longestCall || 0) >= Number(minDuration))) return false;
      if (minCalls && !(j.totalCalls >= Number(minCalls))) return false;
      if (status === 'transcribed' && !(j.transcribed >= 1)) return false;
      if (status === 'none' && j.transcribed !== 0) return false;
      if (status === 'pending' && !(j.pending >= 1)) return false;
      if (hasCalls === 'yes' && !(j.totalCalls >= 1)) return false;
      if (hasCalls === 'no' && j.totalCalls !== 0) return false;

      return true;
    });

    const perPage = Math.min(Number(limit) || 50, 200);
    const current = Math.max(Number(page) || 1, 1);
    const rows = filtered.slice((current - 1) * perPage, current * perPage);
    const withCalls = filtered.filter((j) => j.totalCalls > 0).length;

    res.json({
      success: true,
      count: filtered.length,
      withCalls,
      withoutCalls: filtered.length - withCalls,
      page: current,
      pages: Math.max(Math.ceil(filtered.length / perPage), 1),
      data: rows,
    });
  } catch (err) {
    console.error('Journeys failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to build journeys' });
  }
}

/**
 * GET /api/calls/outcomes — won/lost totals and the loss-reason breakdown.
 * This is the "why are we losing" view; it reads Deals, not Calls, so it counts
 * every closed deal, including the ~44% that have no recorded call at all.
 */
async function outcomeStats(req, res) {
  try {
    const { owner } = req.query;
    const base = {};
    if (owner) base.ownerEmail = owner.toLowerCase();

    const [byOutcome, byReason, byOwner, byProduct, byUpsell] = await Promise.all([
      Deal.aggregate([
        { $match: { ...base, outcome: { $in: ['won', 'lost'] } } },
        { $group: { _id: '$outcome', n: { $sum: 1 }, value: { $sum: '$amount' } } },
      ]),
      Deal.aggregate([
        { $match: { ...base, outcome: 'lost' } },
        { $group: { _id: '$lostReason', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
      ]),
      Deal.aggregate([
        { $match: { ...base, outcome: { $in: ['won', 'lost'] } } },
        {
          $group: {
            _id: '$ownerEmail',
            ownerName: { $first: '$ownerName' },
            won: { $sum: { $cond: [{ $eq: ['$outcome', 'won'] }, 1, 0] } },
            lost: { $sum: { $cond: [{ $eq: ['$outcome', 'lost'] }, 1, 0] } },
          },
        },
        { $sort: { won: -1 } },
      ]),
      // What actually sells, ranked by revenue.
      //
      // WON only, deliberately. The team attaches products when the sale is made,
      // so lost deals are ~4% populated — a win rate per product would be noise
      // dressed up as a number.
      Deal.aggregate([
        { $match: { ...base, outcome: 'won' } },
        { $unwind: '$products' },
        { $match: { 'products.name': { $ne: null } } },
        {
          $group: {
            _id: '$products.name',
            deals: { $sum: 1 },
            units: { $sum: '$products.quantity' },
            revenue: { $sum: '$products.total' },
          },
        },
        { $sort: { revenue: -1 } },
      ]),
      // Upsells — Bigin's Up_Scale picklist. Counted here rather than in the UI
      // because the journeys list is paginated: counting the page would report
      // "3 upsold" when the real answer is 3 out of 159 across every page.
      Deal.aggregate([
        { $match: { ...base, outcome: 'won', upScale: { $ne: null } } },
        { $group: { _id: '$upScale', n: { $sum: 1 }, value: { $sum: '$amount' } } },
        { $sort: { n: -1 } },
      ]),
    ]);

    const won = byOutcome.find((o) => o._id === 'won') || { n: 0, value: 0 };
    const lost = byOutcome.find((o) => o._id === 'lost') || { n: 0, value: 0 };
    const closed = won.n + lost.n;

    res.json({
      success: true,
      won: won.n,
      lost: lost.n,
      wonValue: won.value,
      winRate: closed ? Math.round((won.n / closed) * 100) : 0,
      // `null` is a real answer here: the deal was lost and nobody said why.
      reasons: byReason.map((r) => ({ reason: r._id || null, count: r.n })),
      byOwner: byOwner.map((o) => ({
        ownerEmail: o._id,
        ownerName: o.ownerName,
        won: o.won,
        lost: o.lost,
        winRate: o.won + o.lost ? Math.round((o.won / (o.won + o.lost)) * 100) : 0,
      })),
      products: byProduct.map((p) => ({
        name: p._id,
        deals: p.deals,
        units: p.units || 0,
        revenue: Math.round(p.revenue || 0),
      })),
      upsold: byUpsell.reduce((a, u) => a + u.n, 0),
      upsellValue: Math.round(byUpsell.reduce((a, u) => a + (u.value || 0), 0)),
      upsells: byUpsell.map((u) => ({
        upScale: u._id,
        deals: u.n,
        value: Math.round(u.value || 0),
      })),
    });
  } catch (err) {
    console.error('Outcome stats failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to build outcome stats' });
  }
}

/** GET /api/calls/:id — one call with its transcript + grade. */
async function getCall(req, res) {
  try {
    const call = await Call.findById(req.params.id).lean();
    if (!call) return res.status(404).json({ success: false, message: 'Call not found' });
    res.json({ success: true, data: call });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch call' });
  }
}

/**
 * GET /api/calls/:id/recording — stream the audio to the browser.
 *
 * Proxied through our server (so the TeleCMI secret never reaches the browser)
 * AND transcoded, because TeleCMI's raw MPEG-2.5/8kHz files don't play in
 * browsers. Result is cached, so it's only converted once. res.sendFile gives
 * us Range support, so the player can seek.
 */
async function streamRecording(req, res) {
  try {
    const call = await Call.findById(req.params.id).lean();
    if (!call) return res.status(404).json({ success: false, message: 'Call not found' });
    if (!call.filename) {
      return res.status(404).json({ success: false, message: 'No recording for this call' });
    }

    const { path: filePath } = await audio.getPlayableFile(call.cmiuid, async () => {
      const { buffer } = await telecmi.downloadRecording(call.filename);
      return buffer;
    });

    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(filePath);
  } catch (err) {
    console.error('Recording stream failed:', err.message);
    res.status(502).json({ success: false, message: 'Could not fetch recording' });
  }
}

/** POST /api/calls/sync — pull recent calls from TeleCMI (incremental). */
async function syncCalls(req, res) {
  if (!telecmi.isConfigured()) {
    return res.status(400).json({ success: false, message: 'TeleCMI not configured' });
  }
  // Acquire the lock before the try, so an early 409 return never trips the
  // finally that would release a *different* run's lock.
  if (syncRunning) {
    return res.status(409).json({ success: false, message: 'A sync is already running' });
  }
  syncRunning = true;

  try {
    const days = Number(req.body?.days || 2);
    const from = Date.now() - days * 24 * 60 * 60 * 1000;
    const to = Date.now();

    const agents = agentMap();
    const leadIndex = await buildLeadIndex();

    let created = 0;
    let updated = 0;
    await telecmi.forEachCall({
      from,
      to,
      type: 'answered',
      onRecord: async (row) => {
        const { created: isNew } = await upsertCall(row, leadIndex, agents, {
          minDurationSec: MIN_DURATION,
        });
        if (isNew) created += 1;
        else updated += 1;
      },
    });

    res.json({ success: true, created, updated, days });
  } catch (err) {
    console.error('Call sync failed:', err.message);
    res.status(502).json({ success: false, message: err.message });
  } finally {
    syncRunning = false;
  }
}

module.exports = {
  listCalls,
  listJourneys,
  callStats,
  outcomeStats,
  getCall,
  streamRecording,
  syncCalls,
};
