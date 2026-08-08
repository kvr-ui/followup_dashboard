// Give back the retry budget to calls the transcriber gave up on too early.
//
//   node modules/calls/scripts/retryFailedTranscriptions.js            # dry run — counts only
//   node modules/calls/scripts/retryFailedTranscriptions.js --apply    # re-queue them
//   node modules/calls/scripts/retryFailedTranscriptions.js --apply --all
//
// Why this exists: /v2/play answers 200 with a JSON body when a recording is missing or
// not published yet. downloadRecording checked only the status code, so 42 bytes of
// `{"code":502,"msg":"Internal Server Error"}` were handed to ElevenLabs, which replied
// "File is corrupted. Please ensure it is playable audio." That reads like a bad
// recording, so the call spent all three attempts within minutes — TeleCMI had not
// finished publishing the audio — and was marked `failed` forever.
//
// It was verified, not assumed: re-downloading those recordings today transcribes them
// fine (a 191s call came back with a full Tamil/English transcript). telecmi.js now
// detects the JSON body and flags it isNotReady, and the attempts are spaced over ~9h —
// but calls failed BEFORE that fix still need re-queueing by hand. That is this script.
//
// By default it only re-queues failures matching the misdiagnosis above. A call that
// failed for a reason specific to itself stays given-up-on. --all overrides that.
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../../../config/db');
const Call = require('../models/Call');

const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');

// Errors we now know were the download path lying about the audio, not bad audio.
const MISDIAGNOSED = /corrupt|not available|playable|download failed|502/i;

async function run() {
  await connectDB();

  const stuck = await Call.find({ transcriptionStatus: 'failed' })
    .select('_id transcriptionError transcriptionAttempts startedAt leadName duration filename')
    .lean();

  if (!stuck.length) {
    console.log('Nothing to do — no call is in the `failed` state.');
    return;
  }

  // No filename means there is nothing to re-download; re-queueing it would just fail
  // its way back here. Those belong in `skipped`, not in the retry queue.
  const eligible = stuck.filter(
    (c) => c.filename && (ALL || MISDIAGNOSED.test(c.transcriptionError || ''))
  );
  const skipped = stuck.length - eligible.length;

  const byError = new Map();
  for (const c of eligible) {
    const key = (c.transcriptionError || '(no error recorded)').slice(0, 80);
    byError.set(key, (byError.get(key) || 0) + 1);
  }

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} | ${stuck.length} failed call(s)`);
  console.log(`  re-queueable: ${eligible.length}${ALL ? '  (--all: cause ignored)' : ''}`);
  console.log(`  left alone:   ${skipped}  (no recording, or a call-specific failure)\n`);
  for (const [err, n] of [...byError.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${err}`);
  }

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply to re-queue these.');
    return;
  }
  if (!eligible.length) return;

  // nextAttemptAt null so they are due immediately rather than inheriting a backoff they
  // earned under the old, broken diagnosis.
  const res = await Call.updateMany(
    { _id: { $in: eligible.map((c) => c._id) } },
    {
      $set: {
        transcriptionStatus: 'pending',
        transcriptionAttempts: 0,
        transcriptionError: null,
        nextAttemptAt: null,
      },
    }
  );

  console.log(`\nRe-queued ${res.modifiedCount} call(s). The transcribe poll will pick them up,`);
  console.log('and anything whose audio genuinely does not exist will fail back out on its own.');
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
