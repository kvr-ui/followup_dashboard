// Transcribe ONE call and save the audio + transcript to ../../../../sample/
// so you can listen and read side by side.
//   node modules/calls/scripts/sampleOne.js
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const connectDB = require('../../../config/db');
const Call = require('../models/Call');
const telecmi = require('../services/telecmi');
const elevenlabs = require('../services/elevenlabs');

const OUT_DIR = path.join(__dirname, '../../../../sample');

function ts(sec) {
  const s = Math.round(sec || 0);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

(async () => {
  if (!elevenlabs.isConfigured()) throw new Error('ELEVENLABS_API_KEY not set');
  await connectDB();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Longest pending won-deal call = best quality signal
  const call = await Call.findOne({ transcriptionStatus: 'pending', isClosedWon: true }).sort({
    duration: -1,
  });
  if (!call) throw new Error('No pending won-deal calls');

  console.log('CALL');
  console.log('  lead    :', call.leadName || call.to);
  console.log('  phone   :', call.leadPhone || call.to);
  console.log('  agent   :', call.agentExt, '->', call.ownerEmail);
  console.log('  duration:', call.duration, 'sec');
  console.log('  deal    :', call.deal?.name, '|', call.deal?.stage, '| owner', call.deal?.ownerName);
  console.log('  date    :', call.startedAt);

  // 1) audio
  console.log('\nDownloading recording...');
  const { buffer } = await telecmi.downloadRecording(call.filename);
  const base = `call-${call.cmiuid.slice(0, 8)}`;
  const audioPath = path.join(OUT_DIR, `${base}.mp3`);
  fs.writeFileSync(audioPath, buffer);
  console.log(`  saved: ${audioPath} (${(buffer.length / 1024).toFixed(0)} KB)`);

  // 2) transcribe
  console.log('\nTranscribing via ElevenLabs...');
  const t0 = Date.now();
  const r = await elevenlabs.transcribe(buffer, call.filename);
  if (!r.ok) {
    console.log('FAILED:', r.error);
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`  done in ${Math.round((Date.now() - t0) / 1000)}s | model: ${r.model} | language: ${r.language} (${Math.round((r.languageConfidence || 0) * 100)}%)`);

  // 3) save transcript
  const lines = (r.segments || []).map((s) => `[${ts(s.start)}] ${s.speaker}: ${s.text}`);
  const header = [
    `Call     : ${call.leadName || call.to}  (${call.duration}s)`,
    `Agent    : ${call.agentExt} -> ${call.ownerEmail}`,
    `Deal     : ${call.deal?.name} | ${call.deal?.stage}`,
    `Date     : ${call.startedAt}`,
    `Language : ${r.language} | Model: ${r.model}`,
    ''.padEnd(60, '-'),
    '',
  ].join('\n');

  const txtPath = path.join(OUT_DIR, `${base}.txt`);
  fs.writeFileSync(txtPath, header + lines.join('\n') + '\n');
  const jsonPath = path.join(OUT_DIR, `${base}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ call: call.toObject(), transcript: r }, null, 2));

  console.log(`  saved: ${txtPath}`);
  console.log(`  saved: ${jsonPath}`);

  // 4) persist to DB
  call.transcript = {
    text: r.text, language: r.language, provider: 'elevenlabs', model: r.model,
    segments: r.segments, durationSec: r.durationSec, transcribedAt: new Date(),
  };
  call.transcriptionStatus = 'done';
  await call.save();

  console.log('\n--- TRANSCRIPT (first 30 lines) ---\n');
  lines.slice(0, 30).forEach((l) => console.log(l));
  console.log(`\n[${lines.length} segments, ${(r.text || '').length} characters]`);

  await mongoose.disconnect();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
