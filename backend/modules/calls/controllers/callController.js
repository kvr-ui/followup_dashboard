const Call = require('../models/Call');
const Deal = require('../models/Deal');
const telecmi = require('../services/telecmi');
const audio = require('../services/audio');
const { agentMap, buildLeadIndex, upsertCall } = require('../services/callStore');
const { getJourneys } = require('../services/journeyCache');

const MIN_DURATION = Number(process.env.TELECMI_MIN_DURATION_SEC || 30);

// A sales rep may only ever see their OWN calls/scores. This resolves the owner filter
// for any list/analytics query: an admin may narrow by ?owner=<email> or see everyone;
// a non-admin is HARD-pinned to their own ownerEmail, whatever they pass in the query.
// A rep with no ownerEmail is pinned to a sentinel that matches nothing, so a
// misconfigured account sees zero calls rather than every unmapped (ownerEmail:null) one.
function ownerScope(req) {
  if (req.user && req.user.role === 'admin') {
    return req.query.owner ? { ownerEmail: String(req.query.owner).toLowerCase() } : {};
  }
  const mine = ((req.user && req.user.ownerEmail) || '').toLowerCase();
  return { ownerEmail: mine || '__no_owner_email__' };
}

/** True when the logged-in user is allowed to open this specific call. */
function canSeeCall(req, call) {
  if (!call) return false;
  if (req.user && req.user.role === 'admin') return true;
  const mine = ((req.user && req.user.ownerEmail) || '').toLowerCase();
  return Boolean(mine) && (call.ownerEmail || '').toLowerCase() === mine;
}

// Guards against two concurrent POST /api/calls/sync runs processing the same
// TeleCMI window at once (idempotent on cmiuid, so not corrupting — just wasteful).
let syncRunning = false;

/** GET /api/calls — list with filters (admin only). */
async function listCalls(req, res) {
  try {
    const {
      agent,
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
    // Hard-scope to the logged-in rep (admins may pass ?owner=). Overrides any client owner.
    Object.assign(q, ownerScope(req));

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
    // Reps see stats for their own calls only; admins see everything.
    const base = ownerScope(req);
    const [total, withRec, byStatus, byAgent, graded] = await Promise.all([
      Call.countDocuments({ ...base }),
      Call.countDocuments({ ...base, hasRecording: true }),
      Call.aggregate([{ $match: base }, { $group: { _id: '$transcriptionStatus', n: { $sum: 1 } } }]),
      Call.aggregate([
        { $match: base },
        { $group: { _id: '$agentExt', n: { $sum: 1 }, mins: { $sum: '$duration' } } },
        { $sort: { n: -1 } },
      ]),
      Call.countDocuments({ ...base, 'grade.score': { $ne: null } }),
    ]);
    const matched = await Call.countDocuments({ ...base, leadId: { $ne: null } });

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
    // Admin: optional ?owner=. Sales rep: hard-pinned to their own ownerEmail (sentinel
    // if unset, so they match no journeys rather than everyone's).
    const scoped = ownerScope(req);
    const lcOwner = scoped.ownerEmail || (owner ? owner.toLowerCase() : null);

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
    // Deals carry ownerEmail too, so the same scope applies: reps see only their deals.
    const base = ownerScope(req);

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
    // A rep can only open their own calls — don't let them read a peer's transcript by id.
    if (!canSeeCall(req, call)) {
      return res.status(403).json({ success: false, message: 'Not your call' });
    }
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
    // Same ownership guard as getCall — a rep must not stream a peer's recording by id.
    if (!canSeeCall(req, call)) {
      return res.status(403).json({ success: false, message: 'Not your call' });
    }
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

// The most a criterion can score, per rubric — used to normalise scores to a % so
// "objection_handling 15/30" and "opening 8/10" can be compared on one axis. Must
// stay in step with the rubric in scripts/gradeCalls.js.
const CRITERION_MAX = {
  opening: 10,
  needs_discovery: 25,
  product_pitch: 20,
  objection_handling: 25,
  next_step: 10,
  tone: 10,
  context_recall: 15,
  objection_progress: 30,
  new_value: 20,
  urgency: 15,
};

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

const mean = (nums) => (nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0);

/**
 * Four coaching bands. 90+ is "best" — a call you would actually show a new joiner,
 * which the rubric reserves for genuinely excellent selling (the grader is told 85+ is
 * already rare, so 90+ is a real bar, not a participation trophy).
 */
function bands(scores) {
  const b = { best: 0, good: 0, ok: 0, weak: 0 };
  scores.forEach((s) => {
    if (s >= 90) b.best += 1;
    else if (s >= 70) b.good += 1;
    else if (s >= 50) b.ok += 1;
    else b.weak += 1;
  });
  return b;
}

/**
 * GET /api/calls/grades — the sales scorecard.
 *
 * Aggregates the AI call grades into the numbers a manager actually coaches from:
 * per-rep averages, where the team is weak (by criterion), and the best/worst calls.
 *
 * ── One deliberate choice: 'not_gradeable' calls are EXCLUDED from every average. ──
 * The grader scores a wrong-number or "call me back" as 0/100, correctly — but that
 * is not the rep failing at selling, it is a call where no selling happened. Letting
 * those 0s into a rep's average would punish whoever answered the most dead calls,
 * which is the opposite of what a coaching score is for. They are counted separately
 * so the number is visible, just never blended into skill.
 */
/**
 * Turn a period name into a startedAt filter. Day boundaries are the SERVER's local
 * midnight — the container runs TZ=Asia/Kolkata, so "today" means today in IST, which
 * is what a Tamil Nadu sales floor means by it. 'all' applies no date filter.
 */
function periodFilter(period) {
  if (!period || period === 'all') return {};
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  if (period === 'today') return { startedAt: { $gte: start } };
  if (period === 'yesterday') {
    const y = new Date(start);
    y.setDate(y.getDate() - 1);
    return { startedAt: { $gte: y, $lt: start } };
  }
  if (period === '7d') return { startedAt: { $gte: new Date(Date.now() - 7 * 86400000) } };
  if (period === '30d') return { startedAt: { $gte: new Date(Date.now() - 30 * 86400000) } };
  return {};
}

async function gradeAnalytics(req, res) {
  try {
    // Default: ALL calls (won, lost, open) — a rep's day is every call they made, not
    // only the ones that closed. Pass ?outcome=won to narrow to closed-won.
    const outcomeFilter = req.query.outcome ? { outcome: req.query.outcome } : {};
    // Admins may ?owner=<email>; a sales rep is hard-scoped to their own calls.
    const ownerFilter = ownerScope(req);
    const dateFilter = periodFilter(req.query.period);

    const [calls, eligible, recentRaw, allCalls] = await Promise.all([
      Call.find({ ...outcomeFilter, ...ownerFilter, ...dateFilter, 'grade.score': { $ne: null } })
        .select('grade agentExt ownerEmail duration leadName leadPhone deal startedAt outcome')
        .lean(),
      Call.countDocuments({ ...outcomeFilter, ...ownerFilter, ...dateFilter, hasRecording: true, duration: { $gte: MIN_DURATION } }),
      // Last 14 days, day by day — the trend, independent of the chosen period so the
      // strip is always there to show "how did today/yesterday go".
      Call.find({
        ...outcomeFilter,
        ...ownerFilter,
        'grade.score': { $ne: null },
        startedAt: { $gte: new Date(Date.now() - 14 * 86400000) },
      })
        .select('grade startedAt')
        .lean(),
      // EVERY call in the period (any duration, graded or not) — so the scorecard can
      // show a rep's TOTAL activity next to the graded subset the score is built from.
      // Transcription/grading still only touch >=30s calls; this is display only.
      Call.find({ ...outcomeFilter, ...ownerFilter, ...dateFilter })
        .select('agentExt ownerEmail')
        .lean(),
    ]);

    const agents = agentMap(); // ext -> email

    // The salesperson is whoever MADE the call (the TeleCMI agent), identified by
    // ownerEmail. Deliberately NOT deal.ownerName — that is who owns the LEAD in Bigin,
    // a different person: reps routinely call each other's leads, so naming the row
    // after the lead owner made one agent's calls show up under another's name (the
    // "veera veera appears twice" bug). Derive a display name from the agent's email.
    const pretty = (email) => {
      const local = String(email).split('@')[0].split('.')[0];
      return local ? local.charAt(0).toUpperCase() + local.slice(1) : email;
    };
    const nameOf = (c) => {
      const email = c.ownerEmail || agents[c.agentExt];
      return email ? pretty(email) : c.agentExt || 'unknown';
    };

    // Split real sales conversations from dead calls.
    const gradeable = calls.filter((c) => c.grade.breakdown && c.grade.breakdown.callType !== 'not_gradeable');
    const notGradeable = calls.length - gradeable.length;
    const scores = gradeable.map((c) => c.grade.score);

    // --- Per rep -----------------------------------------------------------------
    // Same canonical key everywhere: resolve agentExt to the email ownerEmail uses, so
    // a call carrying only the extension doesn't spawn a second row for the same person.
    const repKey = (c) => c.ownerEmail || agents[c.agentExt] || c.agentExt || 'unknown';

    const repMap = new Map();
    // Seed from EVERY call so a rep who made calls but has nothing graded yet still
    // shows up with their total activity (calls, not a mysteriously missing row).
    allCalls.forEach((c) => {
      const key = repKey(c);
      if (!repMap.has(key)) repMap.set(key, { key, name: nameOf(c), scores: [], total: 0 });
      repMap.get(key).total += 1;
    });
    // Layer the graded subset on top — this is what the score is built from.
    gradeable.forEach((c) => {
      const key = repKey(c);
      if (!repMap.has(key)) repMap.set(key, { key, name: nameOf(c), scores: [], total: 0 });
      repMap.get(key).scores.push(c.grade.score);
    });
    const perRep = [...repMap.values()]
      .map((r) => ({
        name: r.name,
        ownerEmail: r.key,
        totalCalls: r.total, // ALL calls made in the period (any duration, graded or not)
        calls: r.scores.length, // the graded, gradeable subset the score reflects
        avg: mean(r.scores),
        median: median(r.scores),
        best: r.scores.length ? Math.max(...r.scores) : null,
        worst: r.scores.length ? Math.min(...r.scores) : null,
        bands: bands(r.scores),
      }))
      // Graded reps ranked by score (unchanged); reps with only ungraded activity
      // fall to the bottom, ordered by call volume.
      .sort((a, b) => {
        if (a.calls && b.calls) return b.avg - a.avg;
        if (a.calls !== 0 || b.calls !== 0) return b.calls - a.calls;
        return b.totalCalls - a.totalCalls;
      });

    // --- By call type (the first-call-vs-follow-up insight) ----------------------
    const typeMap = new Map();
    calls.forEach((c) => {
      const t = (c.grade.breakdown && c.grade.breakdown.callType) || 'unknown';
      if (!typeMap.has(t)) typeMap.set(t, []);
      typeMap.get(t).push(c.grade.score);
    });
    const byCallType = [...typeMap.entries()]
      .map(([type, s]) => ({ type, calls: s.length, avg: mean(s) }))
      .sort((a, b) => b.calls - a.calls);

    // --- By criterion, normalised to % — where the team is weakest ---------------
    const critMap = new Map();
    gradeable.forEach((c) => {
      const sc = (c.grade.breakdown && c.grade.breakdown.scores) || {};
      for (const [k, v] of Object.entries(sc)) {
        const val = typeof v === 'object' ? v.score : v;
        const max = CRITERION_MAX[k];
        if (max == null || val == null) continue;
        if (!critMap.has(k)) critMap.set(k, []);
        critMap.get(k).push((val / max) * 100);
      }
    });
    const byCriterion = [...critMap.entries()]
      .map(([criterion, arr]) => ({ criterion, calls: arr.length, pct: mean(arr) }))
      .sort((a, b) => a.pct - b.pct); // weakest first — the coaching priority

    // --- Best / worst calls to drill into ----------------------------------------
    const brief = (c) => ({
      id: c._id,
      lead: c.leadName || (c.deal && c.deal.contactName) || c.leadPhone || '—',
      rep: nameOf(c),
      score: c.grade.score,
      callType: c.grade.breakdown && c.grade.breakdown.callType,
      summary: c.grade.summary,
      minutes: Math.round(c.duration / 60),
    });
    const ranked = [...gradeable].sort((a, b) => b.grade.score - a.grade.score);

    // --- Day-by-day (last 14 days) -----------------------------------------------
    // Local-date key so a call at 11pm IST lands on the right day, not the UTC next day.
    const dayKey = (d) => {
      const x = new Date(d);
      return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    };
    const dayMap = new Map();
    recentRaw
      .filter((c) => c.grade.breakdown && c.grade.breakdown.callType !== 'not_gradeable')
      .forEach((c) => {
        const k = dayKey(c.startedAt);
        if (!dayMap.has(k)) dayMap.set(k, []);
        dayMap.get(k).push(c.grade.score);
      });
    const recentDays = [...dayMap.entries()]
      .map(([date, s]) => ({ date, calls: s.length, avg: mean(s), best: s.filter((x) => x >= 90).length }))
      .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first

    res.json({
      success: true,
      period: req.query.period || 'all',
      coverage: {
        graded: calls.length,
        eligible,
        pct: eligible ? Math.round((calls.length / eligible) * 100) : 0,
      },
      overall: {
        gradeable: gradeable.length,
        notGradeable,
        avg: mean(scores),
        median: median(scores),
        bands: bands(scores),
      },
      perRep,
      byCallType,
      byCriterion,
      recentDays,
      topCalls: ranked.slice(0, 5).map(brief),
      bottomCalls: ranked.slice(-5).reverse().map(brief),
    });
  } catch (err) {
    console.error('Grade analytics failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to build the sales scorecard' });
  }
}

module.exports = {
  listCalls,
  listJourneys,
  callStats,
  outcomeStats,
  gradeAnalytics,
  getCall,
  streamRecording,
  syncCalls,
};
