// Grade call transcripts with an AI, against a rubric — the DEV / VALIDATION tool.
//
//   node modules/calls/scripts/gradeCalls.js            # dry run — prints marks, writes nothing
//   node modules/calls/scripts/gradeCalls.js --apply    # save the marks onto each Call
//   LIMIT=5 node modules/calls/scripts/gradeCalls.js    # just the first 5
//
// The rubric, the model call and the grade shape live in the shared grader service
// (modules/calls/services/grader.js) so this script and the background auto-grader grade
// IDENTICALLY. Edit the rubric THERE, not here. This file exists to eyeball scores in
// bulk (the dry run prints every mark) and to backfill history — the day-to-day grading
// happens automatically in the scheduler.
//
// Reads only calls that already have a transcript; it never calls ElevenLabs.
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../../../config/db');
const Call = require('../models/Call');
const { gradeOne, toGrade, MODEL, isConfigured } = require('../services/grader');

const APPLY = process.argv.includes('--apply');
const CONCURRENCY = Number(process.env.GRADE_CONCURRENCY || 3);
const LIMIT = Number(process.env.LIMIT || 0); // 0 = all

/** Did it obey the English-only rule? Tamil script is U+0B80–U+0BFF. */
const hasTamil = (s) => /[஀-௿]/.test(s);

async function run() {
  if (!isConfigured()) throw new Error('SARVAM_API_KEY not set');
  await connectDB();

  let q = Call.find({ transcriptionStatus: 'done' }).sort({ startedAt: 1 });
  if (LIMIT) q = q.limit(LIMIT);
  const calls = await q.lean();

  // Where does each call sit in that lead's journey? A follow-up must be graded as one.
  const byLead = {};
  for (const c of calls) (byLead[c.leadPhone || String(c._id)] ||= []).push(c);
  for (const c of calls) {
    const arr = byLead[c.leadPhone || String(c._id)];
    c._pos = arr.findIndex((x) => String(x._id) === String(c._id)) + 1;
    c._total = arr.length;
  }

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} | ${MODEL} | ${calls.length} transcript(s)\n`);

  const results = [];
  let inTok = 0, outTok = 0;

  for (let i = 0; i < calls.length; i += CONCURRENCY) {
    const batch = calls.slice(i, i + CONCURRENCY);
    const rs = await Promise.all(batch.map(gradeOne));
    for (let k = 0; k < batch.length; k++) {
      const call = batch[k];
      const r = rs[k];
      if (r.usage) {
        inTok += r.usage.prompt_tokens || 0;
        outTok += r.usage.completion_tokens || 0;
      }
      results.push({ call, r });

      if (APPLY && r.parsed) {
        await Call.updateOne({ _id: call._id }, { $set: { grade: toGrade(r.parsed), gradeError: null } });
      }
    }
    process.stdout.write(`  ...${results.length}/${calls.length}\r`);
  }
  console.log('\n');

  console.log('='.repeat(100));
  console.log('min  type           mark  outcome  summary');
  console.log('='.repeat(100));

  const scores = [];
  let tamilLeaks = 0, fails = 0;
  for (const { call, r } of results) {
    if (r.error || !r.parsed) {
      fails += 1;
      console.log(`${String(Math.round(call.duration / 60)).padStart(3)}  FAILED  ${r.error || 'unparseable JSON'}`);
      continue;
    }
    const p = r.parsed;
    if (hasTamil(JSON.stringify(p.scores) + p.summary)) tamilLeaks += 1;
    if (p.call_type !== 'not_gradeable') scores.push(p.total);
    console.log(
      `${String(Math.round(call.duration / 60)).padStart(3)}  ${String(p.call_type).padEnd(14)} ` +
      `${String(p.total).padStart(4)}  ${String(call.outcome).padEnd(7)}  ${String(p.summary).slice(0, 58)}`
    );
  }

  scores.sort((a, b) => a - b);
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const buckets = { '0-49': 0, '50-69': 0, '70-84': 0, '85-100': 0 };
  scores.forEach((s) => {
    if (s < 50) buckets['0-49'] += 1;
    else if (s < 70) buckets['50-69'] += 1;
    else if (s < 85) buckets['70-84'] += 1;
    else buckets['85-100'] += 1;
  });

  console.log('\n' + '='.repeat(100));
  console.log(`graded        : ${scores.length}   not_gradeable: ${results.length - scores.length - fails}   failed: ${fails}`);
  if (scores.length) {
    console.log(`score range   : ${scores[0]}..${scores[scores.length - 1]}   avg ${avg.toFixed(1)}   median ${scores[Math.floor(scores.length / 2)]}`);
    console.log(`distribution  : ${Object.entries(buckets).map(([k, v]) => `${k}:${v}`).join('   ')}`);
  }
  console.log(`English rule  : ${tamilLeaks === 0 ? 'obeyed' : `BROKEN on ${tamilLeaks}/${results.length}`}`);
  console.log(`cost          : ₹${((inTok / 1e6) * 4 + (outTok / 1e6) * 16).toFixed(2)}  (${inTok} in / ${outTok} out)`);

  // Always dump the full marks — the one-line summaries above hide the reasoning,
  // and the reasoning is what tells you whether the grader can be trusted.
  const out = process.env.GRADE_OUT || '/tmp/grades.json';
  require('fs').writeFileSync(
    out,
    JSON.stringify(
      results.map(({ call, r }) => ({
        callId: String(call._id),
        durationMin: Math.round(call.duration / 60),
        lead: call.leadName,
        agentExt: call.agentExt,
        outcome: call.outcome,
        position: `${call._pos}/${call._total}`,
        grade: r.parsed || null,
        error: r.error || (r.parsed ? null : 'unparseable JSON'),
      })),
      null,
      2
    )
  );
  console.log(`full marks    : ${out}`);
  console.log(APPLY ? '\nMarks saved to each call.' : '\nDRY RUN — nothing written to the DB. Re-run with --apply to save.');

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Grading failed:', err.message);
  process.exit(1);
});
