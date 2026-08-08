// Background jobs for the call-grading module.
//
//  1. Reconcile calls  — poll TeleCMI for recent calls (catches missed webhooks)
//  2. Reconcile deals  — poll Bigin for recently-changed deals (won/lost)
//  3. Transcribe       — work through pending calls
//
// Webhooks are the fast path; these polls are the safety net. We learned in v1
// that webhooks can silently miss events, so we never rely on them alone.

const Call = require('../models/Call');
const Deal = require('../models/Deal');
const telecmi = require('./telecmi');
const elevenlabs = require('./elevenlabs');
const { agentMap, buildLeadIndex, warmLeadIndex, upsertCall, toCallDoc } = require('./callStore');
const { upsertDeal, fetchDealsModifiedSince, shouldTranscribe } = require('./dealStore');
const biginCalls = require('./biginCalls');
const { runBatch, requeueStale } = require('./transcriptionWorker');
const grader = require('./grader');
const { sinceFor, commit, fmtWindow } = require('../../../services/lookback');

const CALL_POLL_MIN = Number(process.env.CALL_POLL_MINUTES || 15);
const BIGIN_POLL_MIN = Number(process.env.BIGIN_CALL_POLL_MINUTES || 10);
const DEAL_POLL_MIN = Number(process.env.DEAL_POLL_MINUTES || 15);
const TRANSCRIBE_EVERY_MIN = Number(process.env.TRANSCRIBE_POLL_MINUTES || 10);
const TRANSCRIBE_BATCH = Number(process.env.TRANSCRIBE_BATCH || 10);
const GRADE_EVERY_MIN = Number(process.env.GRADE_POLL_MINUTES || 10);
const GRADE_BATCH = Number(process.env.GRADE_BATCH || 10);

// First run only (no cursor yet): open the window at the newest record we hold,
// so a fresh deploy doesn't cold-start at 2h and skip what was already missed.
const seedFromNewestCall = async () => {
  const c = await Call.findOne({ startedAt: { $ne: null } }, { startedAt: 1 })
    .sort({ startedAt: -1 })
    .lean();
  return c && c.startedAt ? new Date(c.startedAt).getTime() : null;
};

const seedFromNewestDeal = async () => {
  const d = await Deal.findOne({}, { modifiedTime: 1 }).sort({ modifiedTime: -1 }).lean();
  return d && d.modifiedTime ? new Date(d.modifiedTime).getTime() : null;
};

// If ElevenLabs says we're out of credits, stop hammering it for a while.
let quotaBlockedUntil = 0;
const QUOTA_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// Same idea for Sarvam. A provider-side grade failure (outage, expired key, a model
// that got deprecated under us) fails every call identically, and the grader now
// deliberately does NOT spend the per-call retry budget on it — so without a cooldown
// the same batch would be re-fired every GRADE_POLL_MINUTES forever. Back off instead
// and let the next poll after the cooldown pick the untouched backlog straight up.
let gradeBlockedUntil = 0;
const GRADE_COOLDOWN_MS = 30 * 60 * 1000; // 30 min

let running = { calls: false, outgoing: false, deals: false, bigin: false, transcribe: false, grade: false };

async function reconcileCalls() {
  if (running.calls || !telecmi.isConfigured()) return;
  running.calls = true;

  const startedAt = new Date(); // stamped before the fetch — see lookback.commit()

  try {
    const from = await sinceFor('calls', seedFromNewestCall);
    const to = Date.now();
    console.log(`[reconcile calls] window ${fmtWindow(from)}`);

    const agents = agentMap();
    const leadIndex = await buildLeadIndex();

    let created = 0;
    let revived = 0;
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
          return;
        }

        // `skipped` is a VERDICT, not a fact — and it is usually reached on incomplete
        // data. TeleCMI publishes the recording seconds-to-minutes AFTER the call ends,
        // so the webhook that fired at hangup saw hasRecording=false and wrote `skipped`;
        // this poll is the first moment the recording actually exists. Nothing else
        // revisits that verdict (the branch above is `isNew` only), so without this a
        // perfectly gradeable call is skipped forever and silently misses the scorecard.
        // Re-asking here also lets a widened TRANSCRIBE_SCOPE take effect on its own.
        if (call.transcriptionStatus === 'skipped' && shouldTranscribe(call)) {
          call.transcriptionStatus = 'pending';
          call.transcriptionError = null;
          await call.save();
          revived += 1;
        }
      },
    });

    // Only now is the window truly closed. A throw above leaves the cursor
    // where it was, so the next poll retries this same span.
    await commit('calls', startedAt);

    if (created || revived) {
      require('./journeyCache').invalidate();
      const late = revived ? `, ${revived} skipped call(s) re-queued (recording arrived late)` : '';
      console.log(`[reconcile] ${created} new call(s) from TeleCMI${late}`);
    }
  } catch (err) {
    console.warn('[reconcile calls] failed:', err.message);
  } finally {
    running.calls = false;
  }
}

/**
 * Pull each agent's OUTGOING calls from TeleCMI.
 *
 * /v2/answered returns inbound DID traffic only, so without this poll a rep's outbound
 * day — usually most of their work — never reaches the dashboard. The per-agent
 * /v2/user/out_cdr feed returns the same row shape including `filename`, so these calls
 * download and transcribe through exactly the same path as inbound ones.
 *
 * Both answered (type 1, recorded) and missed (type 0, no audio) are pulled: an
 * unanswered dial is still activity and belongs in the rep's call count, it just
 * cannot be graded.
 */
async function reconcileOutgoingCalls() {
  if (running.outgoing || !telecmi.canReadOutgoing()) return;
  running.outgoing = true;

  const startedAt = new Date();

  try {
    const from = await sinceFor('outgoingCalls', async () => {
      const c = await Call.findOne({ direction: 'outbound' }, { startedAt: 1 })
        .sort({ startedAt: -1 })
        .lean();
      return c && c.startedAt ? new Date(c.startedAt).getTime() : null;
    });
    const to = Date.now();
    console.log(`[reconcile outgoing] window ${fmtWindow(from)}`);

    const agents = agentMap();
    const leadIndex = await buildLeadIndex();
    let created = 0;
    let adopted = 0;

    for (const ext of telecmi.agentExtensions()) {
      for (const type of [1, 0]) {
        await telecmi.forEachOutgoingCall({
          ext,
          from,
          to,
          type,
          onRecord: async (row) => {
            const existing = await Call.findOne({ cmiuid: String(row.cmiuid) });
            if (existing) return; // already ours; the inbound poll never sees these

            const doc = toCallDoc(row, leadIndex, agents);

            // Bigin may already hold this call (it mirrors outbound too). Upgrade that
            // row in place — it gains the cmiuid and the filename that make it
            // transcribable — instead of creating a second row for the same call.
            const twin = await biginCalls.findBiginTwin(doc);
            if (twin) {
              Object.assign(twin, doc, { source: 'telecmi' });
              // It was parked as `skipped` for want of a recording; now there is one.
              if (twin.transcriptionStatus === 'skipped' && shouldTranscribe(twin)) {
                twin.transcriptionStatus = 'pending';
                twin.transcriptionError = null;
              }
              await twin.save();
              adopted += 1;
              return;
            }

            const call = await Call.create({
              ...doc,
              source: 'telecmi',
              transcriptionStatus: shouldTranscribe(doc) ? 'pending' : 'skipped',
            });
            created += 1;
            if (call.transcriptionStatus !== 'pending') return;
          },
        });
      }
    }

    await commit('outgoingCalls', startedAt);

    if (created || adopted) {
      require('./journeyCache').invalidate();
      console.log(
        `[reconcile outgoing] ${created} new outbound call(s), ${adopted} Bigin row(s) upgraded`
      );
    }
  } catch (err) {
    console.warn('[reconcile outgoing] failed:', err.message);
  } finally {
    running.outgoing = false;
  }
}

/**
 * Pull calls from Bigin. This is the ONLY source of outbound calls: TeleCMI's REST API
 * returns inbound DID traffic only (its console shows the outbound legs, the API does
 * not), and reps dial from Bigin via PhoneBridge. Without this poll a rep's day looks
 * like one or two inbound calls when they actually made twenty.
 *
 * Bigin also mirrors the inbound calls, so upsertBiginCall links those to the TeleCMI row
 * we already hold rather than creating a duplicate.
 */
async function reconcileBiginCalls() {
  if (running.bigin) return;
  running.bigin = true;

  const startedAt = new Date();

  try {
    const since = await sinceFor('biginCalls', async () => {
      const c = await Call.findOne({ source: 'bigin' }, { startedAt: 1 })
        .sort({ startedAt: -1 })
        .lean();
      return c && c.startedAt ? new Date(c.startedAt).getTime() : null;
    });
    console.log(`[reconcile bigin] window ${fmtWindow(since)}`);

    const t = await biginCalls.syncSince(since, {
      minDurationSec: Number(process.env.TELECMI_MIN_DURATION_SEC || 30),
    });
    if (t.skipped) return;

    await commit('biginCalls', startedAt);

    if (t.created || t.linked) {
      require('./journeyCache').invalidate();
      console.log(
        `[reconcile bigin] ${t.total} seen — ${t.created} new (${t.queued} queued), ` +
          `${t.linked} linked to existing TeleCMI rows, ${t.updated} refreshed`
      );
    }
  } catch (err) {
    console.warn('[reconcile bigin] failed:', err.message);
  } finally {
    running.bigin = false;
  }
}

async function reconcileDeals() {
  if (running.deals) return;
  running.deals = true;

  const startedAt = new Date();

  try {
    const since = await sinceFor('deals', seedFromNewestDeal);
    console.log(`[reconcile deals] window ${fmtWindow(since)}`);

    const deals = await fetchDealsModifiedSince(since);
    let tagged = 0;
    for (const d of deals) {
      const r = await upsertDeal(d, 'poll');
      tagged += r.tagged;
    }

    await commit('deals', startedAt);

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
    // Recover any call stranded in `processing` by an earlier crash/deploy before we count.
    const revived = await requeueStale();
    if (revived) console.warn(`[transcribe] re-queued ${revived} call(s) stuck in processing`);

    const pending = await Call.countDocuments({ transcriptionStatus: 'pending' });
    if (!pending) return;

    let quotaHit = false;
    let scopeHit = false;
    const res = await runBatch({
      limit: TRANSCRIBE_BATCH,
      concurrency: 2,
      onProgress: ({ result }) => {
        if (result.error && /quota|credits/i.test(result.error)) quotaHit = true;
        if (result.scopeError) scopeHit = true;
      },
    });

    if (quotaHit) {
      quotaBlockedUntil = Date.now() + QUOTA_COOLDOWN_MS;
      console.warn('[transcribe] ElevenLabs quota exhausted — pausing for 1 hour');
    } else if (scopeHit) {
      // Deliberately NOT a cooldown: the transcribe job is shared, so pausing it here
      // would stall inbound TeleCMI calls — which download fine — over a Zoho problem.
      // Normal operation never reaches this branch (Bigin rows are not queued; TeleCMI
      // supplies the audio), so it means a row slipped through. Warn and carry on; the
      // retry budget is untouched either way.
      console.warn(
        '[transcribe] a call fell back to Zoho PhoneBridge and the token lacks that ' +
          'scope. Expected path is TeleCMI out_cdr — check reconcileOutgoingCalls.'
      );
    } else if (res.ok) {
      console.log(`[transcribe] ${res.ok} done, ${res.failed} failed (${pending} were pending)`);
    }
  } catch (err) {
    console.warn('[transcribe] failed:', err.message);
  } finally {
    running.transcribe = false;
  }
}

/**
 * Grade won calls that have a transcript but no score yet. The last stage of the
 * pipeline: reconcile → transcribe → GRADE. A call that closes won is transcribed by
 * the job above, then scored here on the next tick — no manual step, so "today's
 * calls" on the scorecard fill in on their own.
 */
async function gradePending() {
  if (running.grade || !grader.isConfigured()) return;
  if (Date.now() < gradeBlockedUntil) return; // Sarvam is down / misconfigured — back off

  running.grade = true;
  try {
    const pending = await Call.countDocuments({
      transcriptionStatus: 'done',
      'grade.score': null,
      gradeAttempts: { $not: { $gte: grader.MAX_ATTEMPTS } }, // matches missing field too
    });
    if (!pending) return;

    const res = await grader.gradePending({ limit: GRADE_BATCH, concurrency: 3 });

    if (res.providerFaults) {
      gradeBlockedUntil = Date.now() + GRADE_COOLDOWN_MS;
      console.warn(
        `[grade] Sarvam failing on ${res.providerFaults} call(s) — pausing 30 min. ` +
          'Retry budget untouched; fix the provider error and the backlog grades itself.'
      );
    } else if (res.ok || res.failed) {
      const skipped = res.skipped ? `, ${res.skipped} claimed elsewhere` : '';
      console.log(`[grade] ${res.ok} graded, ${res.failed} failed${skipped} (${pending} were pending)`);
    }
  } catch (err) {
    console.warn('[grade] failed:', err.message);
  } finally {
    running.grade = false;
  }
}

function start() {
  if (process.env.CALL_JOBS_ENABLED === 'false') {
    console.log('Call jobs disabled (CALL_JOBS_ENABLED=false)');
    return;
  }

  console.log(
    `Call jobs: calls/${CALL_POLL_MIN}m, bigin/${BIGIN_POLL_MIN}m, deals/${DEAL_POLL_MIN}m, ` +
      `transcribe/${TRANSCRIBE_EVERY_MIN}m, grade/${GRADE_EVERY_MIN}m`
  );

  // Warm the lead index immediately so the first webhook is fast.
  warmLeadIndex().catch((e) => console.warn('lead index warm failed:', e.message));

  // Stagger so they don't all fire at once on boot.
  setTimeout(reconcileCalls, 20 * 1000);
  // Bigin runs after TeleCMI so an inbound call's TeleCMI row already exists and the
  // Bigin copy links to it instead of racing to create a second row for the same call.
  setTimeout(reconcileOutgoingCalls, 35 * 1000);
  setTimeout(reconcileBiginCalls, 45 * 1000);
  setTimeout(reconcileDeals, 60 * 1000);
  // Grade runs after transcribe in the stagger — a call must be transcribed before it
  // can be graded, so there's no point racing them on boot.
  setTimeout(gradePending, 90 * 1000);

  setInterval(reconcileCalls, CALL_POLL_MIN * 60 * 1000);
  setInterval(reconcileOutgoingCalls, CALL_POLL_MIN * 60 * 1000);
  setInterval(reconcileBiginCalls, BIGIN_POLL_MIN * 60 * 1000);
  setInterval(reconcileDeals, DEAL_POLL_MIN * 60 * 1000);
  setInterval(transcribePending, TRANSCRIBE_EVERY_MIN * 60 * 1000);
  setInterval(gradePending, GRADE_EVERY_MIN * 60 * 1000);
}

module.exports = {
  start,
  reconcileCalls,
  reconcileOutgoingCalls,
  reconcileBiginCalls,
  reconcileDeals,
  transcribePending,
  gradePending,
};
