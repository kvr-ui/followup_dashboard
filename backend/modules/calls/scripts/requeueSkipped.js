// Re-queue calls marked `skipped` that TODAY's TRANSCRIBE_SCOPE would accept.
//
//   node modules/calls/scripts/requeueSkipped.js            # dry run — counts only
//   node modules/calls/scripts/requeueSkipped.js --apply    # queue them for transcription
//
// ⚠ COSTS MONEY. Every call this queues is an ElevenLabs transcription plus a Sarvam
// grade. Run the dry run first and look at the count.
//
// Why this exists: shouldTranscribe() is evaluated ONCE, when a call is first ingested
// (see the `if (isNew)` branch in scheduler.reconcileCalls) or when its deal changes.
// Its verdict is then frozen into transcriptionStatus. So when TRANSCRIBE_SCOPE was
// widened from 'won' to 'all', every call already written as `skipped` under the old,
// narrower scope stayed skipped forever — the setting only ever applied to calls ingested
// after the change. That silently left a large backlog of perfectly good recordings out
// of the scorecard, which reads as "why isn't this call graded?".
//
// Calls skipped for a reason that is still true under the current scope (no recording,
// under TELECMI_MIN_DURATION_SEC) are left alone — shouldTranscribe decides, not this
// script, so there is exactly one definition of what is worth transcribing.
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../../../config/db');
const Call = require('../models/Call');
const { shouldTranscribe } = require('../services/dealStore');

const APPLY = process.argv.includes('--apply');
const LIMIT = Number(process.env.LIMIT || 0); // 0 = all

async function run() {
  await connectDB();

  const skipped = await Call.find({ transcriptionStatus: 'skipped' })
    .select('_id duration outcome hasRecording startedAt')
    .sort({ startedAt: -1 })
    .lean();

  // Ask the CURRENT scope about each one. Whatever it says now is the truth.
  const eligible = skipped.filter((c) => shouldTranscribe(c));
  const capped = LIMIT ? eligible.slice(0, LIMIT) : eligible;

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} | scope=${process.env.TRANSCRIBE_SCOPE || 'won'} ` +
    `min=${process.env.TELECMI_MIN_DURATION_SEC || 30}s`);
  console.log(`  skipped calls:       ${skipped.length}`);
  console.log(`  now eligible:        ${eligible.length}`);
  console.log(`  still rightly skipped: ${skipped.length - eligible.length}`);
  if (LIMIT) console.log(`  LIMIT=${LIMIT} — queuing only ${capped.length}`);

  if (capped.length) {
    const mins = Math.round(capped.reduce((s, c) => s + (c.duration || 0), 0) / 60);
    console.log(`\n  ~${mins} minutes of audio to transcribe, then grade. This costs money.`);
    const byOutcome = {};
    for (const c of capped) byOutcome[c.outcome || 'none'] = (byOutcome[c.outcome || 'none'] || 0) + 1;
    console.log('  by outcome:', JSON.stringify(byOutcome));
  }

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply to queue these.');
    return;
  }
  if (!capped.length) return;

  // Clear the stale error text too — 'No recording' from an old skip would otherwise sit
  // on a call that is now queued and transcribing fine.
  const res = await Call.updateMany(
    { _id: { $in: capped.map((c) => c._id) } },
    { $set: { transcriptionStatus: 'pending', transcriptionError: null, transcriptionAttempts: 0 } }
  );

  console.log(`\nQueued ${res.modifiedCount} call(s). The transcribe poll works through ` +
    `TRANSCRIBE_BATCH (${process.env.TRANSCRIBE_BATCH || 10}) every ` +
    `${process.env.TRANSCRIBE_POLL_MINUTES || 10} min, then grading follows automatically.`);
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
