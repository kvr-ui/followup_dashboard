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
const { runBatch, requeueStale, dueFilter } = require('./transcriptionWorker');
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

// How long a call may legitimately still be in flight before the audit calls it late.
// Generous on purpose: the slowest honest path is outbound poll -> transcribe -> grade.
const AUDIT_GRACE_MIN = Number(process.env.PIPELINE_AUDIT_GRACE_MINUTES || 45);
const AUDIT_EVERY_MIN = Number(process.env.PIPELINE_AUDIT_MINUTES || 30);

let running = {
  calls: false,
  outgoing: false,
  deals: false,
  bigin: false,
  transcribe: false,
  grade: false,
  audit: false,
};

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
    let revived = 0;

    for (const ext of telecmi.agentExtensions()) {
      for (const type of [1, 0]) {
        await telecmi.forEachOutgoingCall({
          ext,
          from,
          to,
          type,
          onRecord: async (row) => {
            const existing = await Call.findOne({ cmiuid: String(row.cmiuid) });
            if (existing) {
              // Not "nothing to do": `skipped` is a verdict reached at hangup, when the
              // recording usually did not exist yet. reconcileCalls re-asks that question
              // for inbound calls (see its onRecord) — this poll is the ONLY thing that
              // ever re-sees an outbound call, so without the same branch here an outbound
              // call written off as unrecorded stays written off permanently. Outbound is
              // most of a rep's day, so that asymmetry hid the larger half of the misses.
              //
              // Re-ask against the FRESH row, never the stored one. "The recording arrived
              // late" shows up precisely as filename/record appearing on a call we already
              // hold, so judging the stored copy would consult the same stale
              // hasRecording=false that caused the skip — and the answer would always be
              // no. The inbound path avoids this for free because upsertCall re-assigns
              // the whole doc; this path has to do it deliberately.
              const fresh = toCallDoc(row, leadIndex, agents);
              if (fresh.hasRecording && !existing.hasRecording) {
                existing.filename = fresh.filename;
                existing.hasRecording = true;
              }
              if (existing.transcriptionStatus === 'skipped' && shouldTranscribe(existing)) {
                existing.transcriptionStatus = 'pending';
                existing.transcriptionError = null;
                existing.nextAttemptAt = null;
                revived += 1;
              }
              if (existing.isModified()) await existing.save();
              return;
            }

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

    if (created || adopted || revived) {
      require('./journeyCache').invalidate();
      console.log(
        `[reconcile outgoing] ${created} new outbound call(s), ${adopted} Bigin row(s) upgraded` +
          (revived ? `, ${revived} re-queued (recording arrived late)` : '')
      );

      // Outbound calls are the one path with no webhook behind it, so nothing wakes the
      // pipeline for them: the row lands `pending` and waits for the transcribe tick, then
      // waits again for the grade tick — up to ~35 min from hangup to a score, while an
      // inbound call is graded within a minute by the webhook fast path. Since outbound is
      // most of a rep's day, that delay IS the "today's calls aren't graded" complaint.
      //
      // Drain both stages here rather than duplicating the fast path: these are the same
      // jobs the timers run, each self-guarded by `running`, each honouring its own
      // quota/provider cooldown, each capped at one batch. So this only removes dead
      // waiting — it never widens how much work we do at once.
      await transcribePending();
      await gradePending();
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

    // Count what is actually DUE, not everything pending — a call deliberately waiting
    // out its retry backoff is healthy, and counting it here would report a backlog that
    // the batch then appears to ignore.
    const pending = await Call.countDocuments(dueFilter());
    if (!pending) return;

    let quotaHit = false;
    let scopeHit = false;
    let notReady = 0;
    const res = await runBatch({
      limit: TRANSCRIBE_BATCH,
      concurrency: 2,
      onProgress: ({ result }) => {
        if (result.error && /quota|credits/i.test(result.error)) quotaHit = true;
        if (result.scopeError) scopeHit = true;
        if (result.notReady) notReady += 1;
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
    } else if (res.ok || notReady) {
      const late = notReady ? `, ${notReady} awaiting audio from TeleCMI` : '';
      console.log(
        `[transcribe] ${res.ok} done, ${res.failed} failed${late} (${pending} were due)`
      );
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

/**
 * The safety net: check the END-TO-END invariant instead of trusting each stage.
 *
 * Every stage in this pipeline already retries, and every stage is still capable of
 * dropping a call — because each one only knows about its own step. A call skipped at
 * hangup, a cursor that moved past a late recording, a rep whose extension nobody added
 * to TELECMI_AGENTS: none of those are transcription failures, so nothing in the
 * transcribe/grade path ever notices them. What was actually missing was anything that
 * asks the only question that matters:
 *
 *     is there a call, old enough that it should be done by now, with audio and no score?
 *
 * This runs that query. Anything fixable is put back in the queue; anything genuinely
 * finished-and-unscorable is COUNTED, not retried, so it shows up as a number a human can
 * look at rather than costing credits forever. `heal: false` makes it read-only — that is
 * what the health endpoint serves.
 */
async function pipelineReport({ graceMin = AUDIT_GRACE_MIN, heal = true } = {}) {
  const cutoff = new Date(Date.now() - graceMin * 60 * 1000);
  const old = { startedAt: { $lte: cutoff } };

  // A verdict of `skipped` on a call that HAS audio is the single most common silent
  // miss: it was written at hangup, before the recording existed. Re-ask now.
  // shouldTranscribe depends on outcome under a narrow TRANSCRIBE_SCOPE, so it cannot be
  // expressed as a query — filter in JS. Bounded, because a healthy system has ~none.
  const skippedWithAudio = await Call.find({ ...old, transcriptionStatus: 'skipped', hasRecording: true })
    .limit(500);
  const revivable = skippedWithAudio.filter((c) => shouldTranscribe(c));

  const [inFlight, awaitingGrade, deadTranscribe, deadGradeTotal, noSpeech] = await Promise.all([
    Call.countDocuments({ ...old, transcriptionStatus: { $in: ['pending', 'processing'] } }),
    Call.countDocuments({
      ...old,
      transcriptionStatus: 'done',
      'grade.score': null,
      gradeAttempts: { $not: { $gte: grader.MAX_ATTEMPTS } },
    }),
    Call.countDocuments({ ...old, transcriptionStatus: 'failed' }),
    Call.countDocuments({
      ...old,
      transcriptionStatus: 'done',
      'grade.score': null,
      gradeAttempts: { $gte: grader.MAX_ATTEMPTS },
    }),
    // Recorded silence — ringback, hold music, voicemail. Correctly unscored, and by far
    // the biggest bucket, so it is reported separately: folded into the failure count it
    // makes a healthy pipeline look broken and buries the handful that are real.
    Call.countDocuments({
      ...old,
      transcriptionStatus: 'done',
      'grade.score': null,
      gradeError: 'No transcript',
    }),
  ]);

  // A rep whose extension is not in TELECMI_AGENTS is invisible in a way none of the
  // counts above can show: reconcileOutgoingCalls only logs in as extensions we hold
  // credentials for, so that rep's outbound day is never fetched at all — there is no row
  // to find missing. What we CAN detect is the giveaway: their extension turning up in
  // inbound CDR while being absent from the map. That is a hard signal we are dropping
  // their outbound calls, and it is how a whole person can silently miss the scorecard.
  const agents = agentMap();
  const seenExts = await Call.distinct('agentExt', {
    agentExt: { $ne: null },
    startedAt: { $gte: new Date(Date.now() - 30 * 86400000) },
  });
  const unmappedAgents = seenExts.filter((ext) => !agents[ext]);

  let healed = 0;
  if (heal) {
    healed += await requeueStale();
    for (const call of revivable) {
      call.transcriptionStatus = 'pending';
      call.transcriptionError = null;
      call.nextAttemptAt = null;
      await call.save();
      healed += 1;
    }
  }

  return {
    graceMin,
    checkedBefore: cutoff,
    healed,
    recoverable: revivable.length, // re-queued when heal is on
    inFlight, // pending/processing — the pipeline is working on these
    awaitingGrade, // transcribed, grade still owed
    unmappedAgents, // extensions making calls that TELECMI_AGENTS does not cover
    unscorable: {
      noSpeech, // correct: nothing was said on the call
      transcribeFailed: deadTranscribe, // audio genuinely unusable / never published
      gradeFailed: Math.max(deadGradeTotal - noSpeech, 0), // real grading dead-ends
    },
  };
}

async function auditPipeline() {
  if (running.audit) return;
  running.audit = true;
  try {
    const r = await pipelineReport({ heal: true });
    if (r.healed) {
      require('./journeyCache').invalidate();
      console.log(`[audit] recovered ${r.healed} call(s) that had stalled — re-queued`);
    }
    if (r.unmappedAgents.length) {
      console.warn(
        `[audit] extension(s) ${r.unmappedAgents.join(', ')} are making calls but are not in ` +
          'TELECMI_AGENTS — their OUTBOUND calls are never fetched and that rep is missing ' +
          'from the scorecard. Add <ext>=<email> to TELECMI_AGENTS and restart.'
      );
    }
    // Only speak up about dead ends; in-flight work is not news.
    const dead = r.unscorable.transcribeFailed + r.unscorable.gradeFailed;
    if (dead) {
      console.warn(
        `[audit] ${dead} call(s) will never be scored ` +
          `(${r.unscorable.transcribeFailed} unusable audio, ${r.unscorable.gradeFailed} grading) — ` +
          `plus ${r.unscorable.noSpeech} with no speech, which is expected. ` +
          'Run scripts/retryFailedTranscriptions.js to re-queue the recoverable ones.'
      );
    }
  } catch (err) {
    console.warn('[audit] failed:', err.message);
  } finally {
    running.audit = false;
  }
}

function start() {
  if (process.env.CALL_JOBS_ENABLED === 'false') {
    console.log('Call jobs disabled (CALL_JOBS_ENABLED=false)');
    return;
  }

  console.log(
    `Call jobs: calls/${CALL_POLL_MIN}m, bigin/${BIGIN_POLL_MIN}m, deals/${DEAL_POLL_MIN}m, ` +
      `transcribe/${TRANSCRIBE_EVERY_MIN}m, grade/${GRADE_EVERY_MIN}m, audit/${AUDIT_EVERY_MIN}m`
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
  // can be graded, so there's no point racing them on boot. Transcribe was missing from
  // this list, so anything left `pending` across a restart sat idle for a full
  // TRANSCRIBE_POLL_MINUTES before the first tick; the interval alone never covers boot.
  setTimeout(transcribePending, 75 * 1000);
  setTimeout(gradePending, 90 * 1000);
  // Last in the stagger: the audit judges what the jobs above left behind, so it must
  // not run before they have had their turn.
  setTimeout(auditPipeline, 150 * 1000);

  setInterval(reconcileCalls, CALL_POLL_MIN * 60 * 1000);
  setInterval(reconcileOutgoingCalls, CALL_POLL_MIN * 60 * 1000);
  setInterval(reconcileBiginCalls, BIGIN_POLL_MIN * 60 * 1000);
  setInterval(reconcileDeals, DEAL_POLL_MIN * 60 * 1000);
  setInterval(transcribePending, TRANSCRIBE_EVERY_MIN * 60 * 1000);
  setInterval(gradePending, GRADE_EVERY_MIN * 60 * 1000);
  setInterval(auditPipeline, AUDIT_EVERY_MIN * 60 * 1000);
}

module.exports = {
  start,
  reconcileCalls,
  reconcileOutgoingCalls,
  reconcileBiginCalls,
  reconcileDeals,
  transcribePending,
  gradePending,
  auditPipeline,
  pipelineReport,
};
