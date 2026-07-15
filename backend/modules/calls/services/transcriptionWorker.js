const Call = require('../models/Call');
const telecmi = require('./telecmi');
const elevenlabs = require('./elevenlabs');

const MAX_ATTEMPTS = 3;

// A call held in `processing` longer than this was almost certainly stranded by a
// crash/deploy mid-transcribe (nothing legitimately takes 20 min). The reaper below
// re-queues it so the next poll retries it instead of it being stuck forever.
const PROCESSING_TIMEOUT_MS = 20 * 60 * 1000;

// Out-of-credits / billing errors are transient: top up the account and the same
// call transcribes fine. They must NOT count against the retry budget, or a quota
// outage permanently marks calls `failed` and they're never retried once credits
// return. Real errors (bad audio, unknown model) still count and eventually fail.
const isQuotaError = (msg) => /quota|credits|insufficient|payment|402/i.test(msg || '');

/**
 * Transcribe a single call. Idempotent: a call already `done` is never redone,
 * so re-running the worker costs nothing extra.
 */
async function transcribeCall(call, { force = false } = {}) {
  if (!call) return { ok: false, error: 'No call' };
  if (call.transcriptionStatus === 'done' && !force) {
    return { ok: true, skipped: true, reason: 'already transcribed' };
  }
  if (!call.filename || !call.hasRecording) {
    call.transcriptionStatus = 'skipped';
    call.transcriptionError = 'No recording';
    await call.save();
    return { ok: false, error: 'No recording' };
  }

  // Atomically claim the call: pending -> processing. If another worker (the scheduler
  // batch or the webhook fast-path) already claimed it, findOneAndUpdate returns null and
  // we skip — this is what stops the same recording being downloaded and transcribed (and
  // paid for) twice. `force` (manual re-run) bypasses the claim and re-transcribes.
  if (force) {
    call.transcriptionStatus = 'processing';
    call.processingStartedAt = new Date();
    await call.save();
  } else {
    const claimed = await Call.findOneAndUpdate(
      { _id: call._id, transcriptionStatus: 'pending' },
      { $set: { transcriptionStatus: 'processing', processingStartedAt: new Date() } },
      { new: true }
    );
    if (!claimed) return { ok: false, skipped: true, reason: 'already claimed' };
    call = claimed;
  }

  try {
    const { buffer } = await telecmi.downloadRecording(call.filename);
    const result = await elevenlabs.transcribe(buffer, call.filename);

    if (!result.ok) {
      const quota = isQuotaError(result.error);
      if (!quota) call.transcriptionAttempts = (call.transcriptionAttempts || 0) + 1;
      call.transcriptionError = result.error || 'Transcription failed';
      // Quota errors stay pending forever (no attempt burned); real errors are
      // retryable until we've genuinely given up.
      call.transcriptionStatus =
        !quota && call.transcriptionAttempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      await call.save();
      return { ok: false, error: call.transcriptionError };
    }

    call.transcript = {
      text: result.text,
      language: result.language,
      provider: 'elevenlabs',
      model: result.model,
      segments: result.segments,
      durationSec: result.durationSec,
      transcribedAt: new Date(),
    };
    call.transcriptionStatus = 'done';
    call.transcriptionError = null;
    await call.save();

    return { ok: true, chars: (result.text || '').length, language: result.language };
  } catch (err) {
    const quota = isQuotaError(err.message);
    if (!quota) call.transcriptionAttempts = (call.transcriptionAttempts || 0) + 1;
    call.transcriptionError = err.message;
    call.transcriptionStatus =
      !quota && call.transcriptionAttempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    await call.save();
    return { ok: false, error: err.message };
  }
}

/**
 * Re-queue calls stranded in `processing`. A crash/deploy between claiming a call and
 * writing its terminal status leaves it `processing` forever, and every selector only
 * looks for `pending` — so without this the call is never transcribed again. Run this
 * before each transcribe poll. Returns how many were recovered.
 */
async function requeueStale() {
  const cutoff = new Date(Date.now() - PROCESSING_TIMEOUT_MS);
  const res = await Call.updateMany(
    {
      transcriptionStatus: 'processing',
      // Recent leases are a worker actively transcribing — leave them. Null covers rows
      // stuck before this field existed.
      $or: [{ processingStartedAt: { $lt: cutoff } }, { processingStartedAt: null }],
    },
    { $set: { transcriptionStatus: 'pending' } }
  );
  return res.modifiedCount || 0;
}

/**
 * Work through pending calls with a small worker pool.
 * `limit` caps how many we process in a run — a hard guard against runaway cost.
 * `concurrency` stays low; ElevenLabs 429s are retried with backoff anyway.
 */
async function runBatch({ limit = 10, concurrency = 3, onProgress } = {}) {
  const pending = await Call.find({ transcriptionStatus: 'pending' })
    .sort({ startedAt: -1 })
    .limit(limit);

  let ok = 0;
  let failed = 0;
  let done = 0;
  let cursor = 0;

  async function worker() {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      if (idx >= pending.length) return;

      const call = pending[idx];
      const r = await transcribeCall(call);
      if (r.ok) ok += 1;
      else failed += 1;
      done += 1;
      if (onProgress) onProgress({ i: done, total: pending.length, call, result: r });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) }, () => worker())
  );

  return { processed: pending.length, ok, failed };
}

module.exports = { transcribeCall, runBatch, requeueStale, MAX_ATTEMPTS };
