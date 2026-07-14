const Call = require('../models/Call');
const telecmi = require('./telecmi');
const elevenlabs = require('./elevenlabs');

const MAX_ATTEMPTS = 3;

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

  call.transcriptionStatus = 'processing';
  await call.save();

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

module.exports = { transcribeCall, runBatch, MAX_ATTEMPTS };
