// Transcribe pending call recordings via ElevenLabs.
//
//   node modules/calls/scripts/transcribeCalls.js --one          # 1 call, print it (quality check)
//   node modules/calls/scripts/transcribeCalls.js --limit 20     # process 20
//   node modules/calls/scripts/transcribeCalls.js --all          # process every pending call
//
// Safe to re-run: calls already `done` are never transcribed again.
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../../../config/db');
const Call = require('../models/Call');
const elevenlabs = require('../services/elevenlabs');
const { runBatch, transcribeCall } = require('../services/transcriptionWorker');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

async function run() {
  if (!elevenlabs.isConfigured()) {
    throw new Error('ELEVENLABS_API_KEY is not set in .env');
  }
  await connectDB();

  const one = process.argv.includes('--one');
  const all = process.argv.includes('--all');
  const limit = all ? 10000 : Number(arg('--limit', one ? 1 : 10));

  const pendingTotal = await Call.countDocuments({ transcriptionStatus: 'pending' });
  console.log(`Pending calls: ${pendingTotal} | this run will process: ${Math.min(limit, pendingTotal)}\n`);

  if (one) {
    // Pick the longest pending call — the best quality signal.
    const call = await Call.findOne({ transcriptionStatus: 'pending' }).sort({ duration: -1 });
    if (!call) return console.log('Nothing pending.');

    console.log(`Transcribing: ${call.leadName || call.to} | ${call.duration}s | agent ${call.agentExt}`);
    console.log(`Deal: ${call.deal?.name} (${call.deal?.stage}) — owner ${call.deal?.ownerName}\n`);

    const r = await transcribeCall(call, { force: true });
    if (!r.ok) {
      console.log('FAILED:', r.error);
    } else {
      const fresh = await Call.findById(call._id).lean();
      console.log('--- LANGUAGE:', fresh.transcript.language, '| model:', fresh.transcript.model);
      console.log('--- TRANSCRIPT (by speaker) ---\n');
      (fresh.transcript.segments || []).slice(0, 40).forEach((s) => {
        const t = Math.round(s.start || 0);
        console.log(`[${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}] ${s.speaker}: ${s.text}`);
      });
      console.log(`\n(${(fresh.transcript.text || '').length} characters total)`);
    }
    await mongoose.disconnect();
    return;
  }

  const started = Date.now();
  const res = await runBatch({
    limit,
    onProgress: ({ i, total, call, result }) => {
      const tag = result.ok ? 'ok  ' : 'FAIL';
      console.log(
        `  [${i}/${total}] ${tag} ${call.leadName || call.to} (${call.duration}s)` +
          (result.ok ? ` -> ${result.chars} chars, ${result.language}` : ` -> ${result.error}`)
      );
    },
  });

  const done = await Call.countDocuments({ transcriptionStatus: 'done' });
  const stillPending = await Call.countDocuments({ transcriptionStatus: 'pending' });
  const failed = await Call.countDocuments({ transcriptionStatus: 'failed' });

  console.log(`\nDone in ${Math.round((Date.now() - started) / 1000)}s.`);
  console.log(`  this run: ${res.ok} ok, ${res.failed} failed`);
  console.log(`  overall: ${done} transcribed | ${stillPending} pending | ${failed} failed`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Transcription run failed:', err.message);
  process.exit(1);
});
