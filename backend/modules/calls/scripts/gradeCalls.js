// Grade call transcripts with an AI, against a rubric.
//
//   node modules/calls/scripts/gradeCalls.js            # dry run — prints marks, writes nothing
//   node modules/calls/scripts/gradeCalls.js --apply    # save the marks onto each Call
//
// Reads only calls that already have a transcript. Transcription is a separate,
// earlier step (transcriptionWorker.js) — this script never calls ElevenLabs.
//
// ============================================================================
//  THE RUBRIC BELOW IS THE POINT OF THIS FILE. EDIT IT.
//
//  It decides what "a good call" means at FOCAS. Sales managers should own it,
//  not the person who wrote the code. Two things matter most:
//
//   1. ANCHORS. Every score level says what evidence earns it. Without anchors
//      the model shrugs and gives everything 25/25 — a vague rubric produces a
//      useless score. If you change a criterion, change its anchors too.
//
//   2. CALL TYPE. A follow-up call has no introduction and no discovery — the
//      rep already knows the lead. Grading it against the first-call rubric would
//      punish a rep for doing the right thing. So the model decides the call type
//      first, then grades against the matching rubric.
// ============================================================================
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../../../config/db');
const Call = require('../models/Call');

const API_URL = 'https://api.sarvam.ai/v1/chat/completions';
const API_KEY = process.env.SARVAM_API_KEY;
// sarvam-30b, not 105b. Both are reasoning models that spend hidden output tokens
// "thinking" before answering, and the starter tier caps output at 4096. 105b burns
// so much of that budget reasoning that the marks JSON gets truncated mid-object;
// 30b reasons ~5x less, leaving room for the full answer. Override with SARVAM_MODEL
// if you upgrade the tier (105b is the sharper grader when it can actually finish).
const MODEL = process.env.SARVAM_MODEL || 'sarvam-30b';

const APPLY = process.argv.includes('--apply');
const CONCURRENCY = Number(process.env.GRADE_CONCURRENCY || 3);
const LIMIT = Number(process.env.LIMIT || 0); // 0 = all

// ---------------------------------------------------------------------------
// RUBRIC 1 — FIRST CALL (rep and lead have never spoken)
// ---------------------------------------------------------------------------
const FIRST_CALL_RUBRIC = `
RUBRIC — FIRST CALL (the rep and lead have not spoken before)

opening (10)
  10 = named themselves AND FOCAS, and said why they were calling
   5 = named the academy but not themselves, or vice versa
   0 = launched straight into questions or a pitch with no introduction

needs_discovery (25)
  25 = asked about the exam sitting, which group/level, first attempt or repeat, AND
       their situation (working? studying? struggling with what?) — and then USED
       those answers later in the call
  15 = asked several of those, but pitched the same way regardless of the answers
   8 = asked one or two questions and moved on
   0 = pitched without asking anything about the lead

product_pitch (20)
  20 = explained the course/batch/fee in terms of THIS lead's stated problem
  12 = competent but generic pitch — the same one they'd give anyone
   5 = listed features with no link to the lead
   0 = no real pitch

objection_handling (25)
  25 = the lead raised a doubt (fees, timing, language, "let me think") and the rep
       answered it directly, and the lead accepted the answer
  15 = answered, but only partly, or the lead was left unconvinced
   5 = deflected, talked over it, or changed the subject
   0 = ignored the objection entirely
  If the lead raised NO objection, score on whether the rep probed for hidden concerns.
  A call with no objections and no probing is NOT a 25 — cap it at 12.

next_step (10)
  10 = a concrete commitment with a DATE or an action (payment link sent, demo class
       booked for a named day, callback agreed for a specific day)
   5 = something will be sent (brochure/details) but no date and no commitment
   0 = "I'll call you" / "think about it" / nothing agreed

tone (10)
  10 = patient, respectful, let the lead finish, not pushy
   5 = fine but rushed, or talked over the lead a few times
   0 = rude, aggressive, or dismissive
`;

// ---------------------------------------------------------------------------
// RUBRIC 2 — FOLLOW-UP CALL (they've spoken before — do NOT expect an intro)
// ---------------------------------------------------------------------------
const FOLLOWUP_RUBRIC = `
RUBRIC — FOLLOW-UP CALL (they have spoken before; do NOT expect an introduction)

context_recall (15)
  15 = clearly remembered the previous conversation and referred to it specifically
   8 = vaguely remembered
   0 = started from zero, as if they had never spoken — made the lead repeat themselves

objection_progress (30)
  30 = the doubt the lead had last time (fees / timing / family approval / language) was
       specifically revisited and moved forward or resolved
  15 = touched on it but did not resolve it
   5 = re-pitched the same thing without addressing the actual blocker
   0 = never addressed why the lead had not decided yet

new_value (20)
  20 = brought something NEW to move the deal — an offer, a demo, a deadline, a
       concession, proof, a new batch date
  10 = repeated what was already said, but usefully
   0 = "just checking, sir" — a wasted call that added nothing

urgency (15)
  15 = gave a genuine, honest reason to decide now (batch filling, class starting, fee
       deadline) without lying or pressuring
   8 = a mild nudge
   0 = no urgency at all — left it completely open-ended

next_step (10)
  10 = a concrete commitment with a DATE
   5 = a vague "I'll send details"
   0 = nothing agreed

tone (10)
  10 = patient, respectful, not pestering
   5 = rushed or slightly pushy
   0 = rude or harassing
`;

const SYSTEM = `You grade sales calls for FOCAS, a CA (chartered accountancy) coaching academy in Tamil Nadu.

################ ABSOLUTE OUTPUT RULE — READ TWICE ################
The call is in TAMIL (sometimes English or Hindi). You must READ it in Tamil.
But EVERY WORD YOU WRITE must be in ENGLISH. The sales managers who read these
marks do not read Tamil script. If you write any explanation in Tamil, your entire
answer is WORTHLESS and will be thrown away. You may quote a short Tamil phrase as
evidence, but every explanation, summary, strength and improvement must be ENGLISH.
###################################################################

STEP 1 — WHO IS WHO.
The transcript has speaker_0 and speaker_1. These labels are ARBITRARY and tell you
nothing about who is who. Work out which one is the FOCAS salesperson (representing the
academy, explaining courses, quoting fees) and which is the LEAD (a prospective student
or their parent). State the evidence.

STEP 2 — WHAT KIND OF CALL IS THIS?
  "first_call"     — speaking for the first time; the rep introduces the academy
  "follow_up"      — they have spoken before; the rep is chasing a decision
  "closing"        — the lead has decided; this is about payment/joining logistics
  "not_gradeable"  — no real sales conversation happened (no answer, wrong number, a few
                     seconds of "call me back", the lead could not talk). Be honest: if
                     there was no real conversation, say not_gradeable and do NOT invent
                     scores.

STEP 3 — GRADE THE SALESPERSON (never the lead) against the rubric for that call type.

${FIRST_CALL_RUBRIC}

${FOLLOWUP_RUBRIC}

For "closing" calls, use the FOLLOW-UP rubric.
For "not_gradeable", set every score to 0 and total to 0.

BE A HARSH, HONEST GRADER. Most real sales calls are mediocre. A score above 85 means the
call was genuinely excellent and you would show it to new joiners as an example. If you
find yourself giving everything 90+, you are being lazy. Reward only what ACTUALLY
HAPPENED in the transcript. If the rep did not do something, score it 0 and say so plainly.

OUTPUT — this is critical. Start your reply with '{' and output ONLY the JSON object,
no markdown fence, no text before or after it. Your output budget is SMALL, so keep
every text value SHORT or the answer gets cut off and thrown away:
  - each "why": ONE short phrase, max ~12 words, may quote a few Tamil words as evidence
  - "summary": 1-2 short sentences
  - at most 2 strengths and 2 improvements, each max ~10 words
ALL VALUES IN ENGLISH.
{
  "salesperson_speaker": "speaker_0" | "speaker_1",
  "speaker_evidence": "<max 10 words>",
  "call_type": "first_call" | "follow_up" | "closing" | "not_gradeable",
  "call_type_reason": "<max 10 words>",
  "scores": { "<criterion>": {"score": <n>, "why": "<max 12 words>"} },
  "total": <0-100>,
  "summary": "<1-2 sentences: what actually happened>",
  "strengths": ["<max 10 words>", "<max 10 words>"],
  "improvements": ["<max 10 words>", "<max 10 words>"]
}`;

/** Speaker-labelled transcript is far more gradeable than the flat text blob. */
function transcriptText(call) {
  const segs = (call.transcript && call.transcript.segments) || [];
  if (segs.length) return segs.map((s) => `[${s.speaker}] ${s.text}`).join('\n');
  return (call.transcript && call.transcript.text) || '';
}

async function gradeOne(call) {
  // One network/parse error must not reject the whole Promise.all batch and kill
  // the run — isolate each call so a single failure just gets reported and skipped.
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content:
              `Call: ${Math.round(call.duration / 60)} min, ${call.direction}, ` +
              `outcome=${call.outcome}, call #${call._pos} of ${call._total} to this lead.\n\n` +
              `TRANSCRIPT:\n${transcriptText(call)}`,
          },
        ],
        // Starter tier hard-caps output at 4096 (incl. the model's hidden reasoning).
        // Paired with sarvam-30b + the COMPACT output spec in SYSTEM, the marks JSON
        // fits comfortably. Raise this only after upgrading the Sarvam tier.
        max_tokens: 4096,
        temperature: 0.2,
        // The decisive setting. Left to reason freely, sarvam-30b burns the entire
        // 4096-token output budget "thinking" through the 6-criterion rubric and the
        // JSON gets truncated. 'low' caps the reasoning so it spends the budget on the
        // answer instead — the anchored rubric does the heavy lifting, so it doesn't
        // need to deliberate at length to score against explicit evidence levels.
        reasoning_effort: 'low',
      }),
    });

    const json = await res.json();
    if (json.error) return { error: JSON.stringify(json.error).slice(0, 150) };

    const raw = ((json.choices && json.choices[0] && json.choices[0].message.content) || '')
      .trim()
      .replace(/^```(?:json)?|```$/g, '')
      .trim();

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/); // reasoning models sometimes wrap the JSON in prose
      if (m) { try { parsed = JSON.parse(m[0]); } catch { /* leave null */ } }
    }
    return { parsed, raw, usage: json.usage };
  } catch (err) {
    return { error: `request failed: ${err.message}`.slice(0, 150) };
  }
}

/** Did it obey the English-only rule? Tamil script is U+0B80–U+0BFF. */
const hasTamil = (s) => /[஀-௿]/.test(s);

async function run() {
  if (!API_KEY) throw new Error('SARVAM_API_KEY not set');
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
        const p = r.parsed;
        await Call.updateOne(
          { _id: call._id },
          {
            $set: {
              grade: {
                score: p.total,
                // salespersonSpeaker lets the transcript UI label who's who
                // correctly — the grader works it out per call; it isn't fixed.
                breakdown: {
                  callType: p.call_type,
                  salespersonSpeaker: p.salesperson_speaker || null,
                  scores: p.scores,
                },
                summary: p.summary,
                strengths: p.strengths || [],
                improvements: p.improvements || [],
                gradedBy: 'ai',
                gradedAt: new Date(),
              },
            },
          }
        );
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
  // If everything lands 85+, the rubric anchors aren't biting — tighten them.
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
