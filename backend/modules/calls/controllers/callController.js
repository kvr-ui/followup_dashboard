const Call = require('../models/Call');
const telecmi = require('../services/telecmi');
const audio = require('../services/audio');
const { agentMap, buildLeadIndex, upsertCall } = require('../services/callStore');

const MIN_DURATION = Number(process.env.TELECMI_MIN_DURATION_SEC || 30);

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
 * GET /api/calls/journeys — closed-won leads, with all their calls grouped.
 * A sale is a journey of several calls, so this is the primary admin view.
 */
async function listJourneys(req, res) {
  try {
    const { owner, search } = req.query;

    const match = { isClosedWon: true };
    if (owner) match['deal.ownerEmail'] = owner.toLowerCase();
    if (search) {
      const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      match.$or = [{ 'deal.contactName': rx }, { leadName: rx }, { leadPhone: rx }];
    }

    const journeys = await Call.aggregate([
      { $match: match },
      { $sort: { startedAt: 1 } },
      {
        $group: {
          _id: '$deal.contactId',
          contactName: { $first: '$deal.contactName' },
          phone: { $first: '$leadPhone' },
          deal: { $first: '$deal' },
          totalCalls: { $sum: 1 },
          totalDuration: { $sum: '$duration' },
          transcribed: {
            $sum: { $cond: [{ $eq: ['$transcriptionStatus', 'done'] }, 1, 0] },
          },
          avgScore: { $avg: '$grade.score' },
          firstCall: { $min: '$startedAt' },
          lastCall: { $max: '$startedAt' },
          calls: {
            $push: {
              _id: '$_id',
              startedAt: '$startedAt',
              duration: '$duration',
              direction: '$direction',
              agentExt: '$agentExt',
              ownerEmail: '$ownerEmail',
              transcriptionStatus: '$transcriptionStatus',
              score: '$grade.score',
              hasRecording: '$hasRecording',
            },
          },
        },
      },
      { $sort: { totalCalls: -1, lastCall: -1 } },
    ]);

    res.json({ success: true, count: journeys.length, data: journeys });
  } catch (err) {
    console.error('Journeys failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to build journeys' });
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
  try {
    if (!telecmi.isConfigured()) {
      return res.status(400).json({ success: false, message: 'TeleCMI not configured' });
    }

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
  }
}

module.exports = { listCalls, listJourneys, callStats, getCall, streamRecording, syncCalls };
