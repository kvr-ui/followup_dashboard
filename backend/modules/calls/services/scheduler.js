// Background jobs for the call-grading module.
//
//  1. Reconcile calls  — poll TeleCMI for recent calls (catches missed webhooks)
//  2. Reconcile deals  — poll Bigin for recently-changed deals (won/lost)
//  3. Transcribe       — work through pending calls
//
// Webhooks are the fast path; these polls are the safety net. We learned in v1
// that webhooks can silently miss events, so we never rely on them alone.

const Call = require('../models/Call');
const telecmi = require('./telecmi');
const elevenlabs = require('./elevenlabs');
const { agentMap, buildLeadIndex, warmLeadIndex, upsertCall } = require('./callStore');
const { upsertDeal, fetchDealsModifiedSince, shouldTranscribe } = require('./dealStore');
const { runBatch } = require('./transcriptionWorker');

const CALL_POLL_MIN = Number(process.env.CALL_POLL_MINUTES || 15);
const DEAL_POLL_MIN = Number(process.env.DEAL_POLL_MINUTES || 15);
const TRANSCRIBE_EVERY_MIN = Number(process.env.TRANSCRIBE_POLL_MINUTES || 10);
const TRANSCRIBE_BATCH = Number(process.env.TRANSCRIBE_BATCH || 10);

// If ElevenLabs says we're out of credits, stop hammering it for a while.
let quotaBlockedUntil = 0;
const QUOTA_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

let running = { calls: false, deals: false, transcribe: false };

async function reconcileCalls() {
  if (running.calls || !telecmi.isConfigured()) return;
  running.calls = true;
  try {
    const from = Date.now() - 2 * 60 * 60 * 1000; // last 2 hours
    const to = Date.now();
    const agents = agentMap();
    const leadIndex = await buildLeadIndex();

    let created = 0;
    await telecmi.forEachCall({
      from,
      to,
      type: 'answered',
      onRecord: async (row) => {
        const { call, created: isNew } = await upsertCall(row, leadIndex, agents, {
          minDurationSec: 0,
        });
        if (isNew) {
          created += 1;
          if (call.transcriptionStatus !== 'done') {
            call.transcriptionStatus = shouldTranscribe(call) ? 'pending' : 'skipped';
            await call.save();
          }
        }
      },
    });
    if (created) console.log(`[reconcile] ${created} new call(s) from TeleCMI`);
  } catch (err) {
    console.warn('[reconcile calls] failed:', err.message);
  } finally {
    running.calls = false;
  }
}

async function reconcileDeals() {
  if (running.deals) return;
  running.deals = true;
  try {
    const since = Date.now() - 2 * 60 * 60 * 1000; // last 2 hours
    const deals = await fetchDealsModifiedSince(since);
    let tagged = 0;
    for (const d of deals) {
      const r = await upsertDeal(d, 'poll');
      tagged += r.tagged;
    }
    if (deals.length) {
      console.log(`[reconcile] ${deals.length} deal(s) refreshed, ${tagged} call(s) re-tagged`);
    }
  } catch (err) {
    console.warn('[reconcile deals] failed:', err.message);
  } finally {
    running.deals = false;
  }
}

async function transcribePending() {
  if (running.transcribe || !elevenlabs.isConfigured()) return;
  if (Date.now() < quotaBlockedUntil) return; // out of credits — back off

  running.transcribe = true;
  try {
    const pending = await Call.countDocuments({ transcriptionStatus: 'pending' });
    if (!pending) return;

    let quotaHit = false;
    const res = await runBatch({
      limit: TRANSCRIBE_BATCH,
      concurrency: 2,
      onProgress: ({ result }) => {
        if (result.error && /quota|credits/i.test(result.error)) quotaHit = true;
      },
    });

    if (quotaHit) {
      quotaBlockedUntil = Date.now() + QUOTA_COOLDOWN_MS;
      console.warn('[transcribe] ElevenLabs quota exhausted — pausing for 1 hour');
    } else if (res.ok) {
      console.log(`[transcribe] ${res.ok} done, ${res.failed} failed (${pending} were pending)`);
    }
  } catch (err) {
    console.warn('[transcribe] failed:', err.message);
  } finally {
    running.transcribe = false;
  }
}

function start() {
  if (process.env.CALL_JOBS_ENABLED === 'false') {
    console.log('Call jobs disabled (CALL_JOBS_ENABLED=false)');
    return;
  }

  console.log(
    `Call jobs: calls/${CALL_POLL_MIN}m, deals/${DEAL_POLL_MIN}m, transcribe/${TRANSCRIBE_EVERY_MIN}m`
  );

  // Warm the lead index immediately so the first webhook is fast.
  warmLeadIndex().catch((e) => console.warn('lead index warm failed:', e.message));

  // Stagger so they don't all fire at once on boot.
  setTimeout(reconcileCalls, 20 * 1000);
  setTimeout(reconcileDeals, 60 * 1000);

  setInterval(reconcileCalls, CALL_POLL_MIN * 60 * 1000);
  setInterval(reconcileDeals, DEAL_POLL_MIN * 60 * 1000);
  setInterval(transcribePending, TRANSCRIBE_EVERY_MIN * 60 * 1000);
}

module.exports = { start, reconcileCalls, reconcileDeals, transcribePending };
