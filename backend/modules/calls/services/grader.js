// The call grader. ONE source of truth for the rubric and the model call, used by
// both the background worker (services/scheduler.js) and the CLI (scripts/gradeCalls.js).
//
// ============================================================================
//  THE RUBRIC BELOW IS THE POINT OF THIS FILE. Sales managers own it, not the
//  person who wrote the code. Two things matter most:
//   1. ANCHORS — every score level states the evidence that earns it. A vague
//      rubric makes the model give everything 25/25.
//   2. CALL TYPE — a follow-up has no intro or discovery; grading it against the
//      first-call rubric punishes a rep for doing the right thing. So the model
//      decides the call type first, then grades against the matching rubric.
// ============================================================================

const Call = require('../models/Call');

const API_URL = 'https://api.sarvam.ai/v1/chat/completions';
const API_KEY = process.env.SARVAM_API_KEY;
// sarvam-30b, not 105b: both are reasoning models and the starter tier caps output at
// 4096 tokens; 105b burns that budget "thinking" and truncates the JSON. See gradeOne.
const MODEL = process.env.SARVAM_MODEL || 'sarvam-30b';

// A won call that fails this many times stops being retried (usually a transcript too
// long to fit the token budget). It stays ungraded rather than costing credits forever.
const MAX_ATTEMPTS = Number(process.env.GRADE_MAX_ATTEMPTS || 3);

// A grade lease held longer than this is stale (crashed mid-grade) and can be reclaimed.
const GRADE_LEASE_MS = 10 * 60 * 1000;

function isConfigured() {
  return Boolean(API_KEY);
}

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

// A very long call blows the model's OUTPUT budget: it "thinks" roughly in proportion
// to the input and then truncates the JSON. Keep the call under this many characters.
// ~12k chars ≈ 4k input tokens, which leaves the 4096 output cap room to finish.
const MAX_TRANSCRIPT_CHARS = Number(process.env.GRADE_MAX_TRANSCRIPT_CHARS || 12000);

// Middle-out trim: keep the OPENING and CLOSING of the call, drop the repetitive
// middle. Never blind-cut the tail — next_step and objection_handling are graded from
// how the call CLOSES, so losing the end would unfairly zero those scores. Head gets
// the larger share (intro + discovery context) and the tail is always preserved.
function trimMiddleOut(lines, maxChars) {
  const full = lines.join('\n');
  if (full.length <= maxChars) return full;

  const headBudget = Math.floor(maxChars * 0.6);
  const tailBudget = maxChars - headBudget;

  const head = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > headBudget) break;
    head.push(l);
    used += l.length + 1;
  }
  const tail = [];
  used = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    if (used + lines[i].length + 1 > tailBudget) break;
    tail.unshift(lines[i]);
    used += lines[i].length + 1;
  }

  // Pathological single huge line (flat transcript, no segments): fall back to a raw
  // character slice so we never return only the marker.
  if (!head.length && !tail.length) {
    return `${full.slice(0, headBudget)}\n[… middle of the call omitted for length …]\n${full.slice(full.length - tailBudget)}`;
  }

  const dropped = lines.length - head.length - tail.length;
  return [...head, `[… ${dropped} lines from the middle of the call omitted for length …]`, ...tail].join('\n');
}

/** Speaker-labelled transcript is far more gradeable than the flat text blob. */
function transcriptText(call) {
  const segs = (call.transcript && call.transcript.segments) || [];
  const lines = segs.length
    ? segs.map((s) => `[${s.speaker}] ${s.text}`)
    : String((call.transcript && call.transcript.text) || '').split('\n');
  return trimMiddleOut(lines, MAX_TRANSCRIPT_CHARS);
}

/** A parse only counts if it carries a usable score — reject half-salvaged garbage. */
function isValidGrade(p) {
  return Boolean(p && typeof p.total === 'number' && p.scores && typeof p.scores === 'object');
}

/** Direct parse, then the reasoning-model-wraps-JSON-in-prose case. */
function tryParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fall through */
      }
    }
  }
  return null;
}

/**
 * Salvage a TRUNCATED JSON object (the long-call failure mode): the model ran out of
 * output budget mid-object. Walk back from the end to the last position that parses
 * once we re-balance the open braces/brackets it never got to close.
 */
function salvageJson(raw) {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  const s = raw.slice(start);
  for (let end = s.length; end > 1; end--) {
    const c = s[end - 1];
    // Only bother trying to close at a plausible value boundary.
    if (c !== '}' && c !== ']' && c !== '"' && !/[0-9a-z]/i.test(c)) continue;
    let cand = s.slice(0, end);
    const openBrace = (cand.match(/\{/g) || []).length - (cand.match(/\}/g) || []).length;
    const openBrack = (cand.match(/\[/g) || []).length - (cand.match(/\]/g) || []).length;
    if (openBrace < 0 || openBrack < 0) continue;
    cand += ']'.repeat(openBrack) + '}'.repeat(openBrace);
    try {
      const p = JSON.parse(cand);
      if (isValidGrade(p)) return p;
    } catch {
      /* keep shrinking */
    }
  }
  return null;
}

/**
 * Last resort for the FLAKY failure mode (a short call where the model just emitted
 * bad JSON once): hand the broken text back and ask it to return valid JSON only.
 */
async function reaskJson(raw) {
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You repair malformed JSON. Output ONLY the corrected JSON object — no prose, no code fences, no reasoning. Complete any truncated fields sensibly.',
          },
          { role: 'user', content: `Fix this into valid JSON:\n\n${raw.slice(0, 6000)}` },
        ],
        max_tokens: 4096,
        temperature: 0,
        reasoning_effort: 'low',
      }),
    });
    const json = await res.json();
    if (json.error) return null;
    const txt = ((json.choices && json.choices[0] && json.choices[0].message.content) || '')
      .trim()
      .replace(/^```(?:json)?|```$/g, '')
      .trim();
    const p = tryParse(txt);
    return isValidGrade(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * Call Sarvam and parse the marks. Returns { parsed, raw, usage } or { error }.
 * Never throws — a single bad call must not kill a batch.
 */
async function gradeOne(call) {
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
              `outcome=${call.outcome}, call #${call._pos || 1} of ${call._total || 1} to this lead.\n\n` +
              `TRANSCRIPT:\n${transcriptText(call)}`,
          },
        ],
        // Starter tier hard-caps output at 4096 (incl. the model's hidden reasoning).
        // reasoning_effort:'low' stops sarvam-30b burning that whole budget thinking and
        // truncating the JSON — the anchored rubric means it doesn't need to deliberate.
        max_tokens: 4096,
        temperature: 0.2,
        reasoning_effort: 'low',
      }),
    });

    const json = await res.json();
    if (json.error) return { error: JSON.stringify(json.error).slice(0, 150) };

    const raw = ((json.choices && json.choices[0] && json.choices[0].message.content) || '')
      .trim()
      .replace(/^```(?:json)?|```$/g, '')
      .trim();

    // 1) normal parse, 2) salvage a truncated object (long calls), 3) ask the model to
    // repair it (flaky short calls). Each fallback is tried only if the prior failed.
    let parsed = tryParse(raw);
    if (!isValidGrade(parsed)) parsed = salvageJson(raw);
    if (!isValidGrade(parsed)) parsed = await reaskJson(raw);
    return { parsed: isValidGrade(parsed) ? parsed : null, raw, usage: json.usage };
  } catch (err) {
    return { error: `request failed: ${err.message}`.slice(0, 150) };
  }
}

/** Shape a parsed model response into the Call.grade sub-document. */
function toGrade(parsed) {
  return {
    score: parsed.total,
    breakdown: {
      callType: parsed.call_type,
      // Lets the transcript UI label who's who — the grader works it out per call.
      salespersonSpeaker: parsed.salesperson_speaker || null,
      scores: parsed.scores,
    },
    summary: parsed.summary,
    strengths: parsed.strengths || [],
    improvements: parsed.improvements || [],
    gradedBy: 'ai',
    gradedAt: new Date(),
  };
}

/** Where does this call sit in its lead's journey? A follow-up must be graded as one. */
async function positionInJourney(call) {
  if (!call.leadPhone) return { pos: 1, total: 1 };
  const siblings = await Call.find({ leadPhone: call.leadPhone })
    .select('_id startedAt')
    .sort({ startedAt: 1 })
    .lean();
  const pos = siblings.findIndex((c) => String(c._id) === String(call._id)) + 1;
  return { pos: pos || 1, total: siblings.length || 1 };
}

/**
 * Grade one call and SAVE the result. Returns { ok, score } or { ok:false, error }.
 * On failure it records the error and bumps the attempt counter so the worker can
 * eventually give up instead of retrying a hopeless call every poll.
 */
async function gradeCall(call) {
  if (!isConfigured()) return { ok: false, error: 'SARVAM_API_KEY not set' };
  if (!call.transcript || !transcriptText(call)) {
    // Empty transcript (silent / voicemail-length call): nothing to grade, and it will
    // never become gradeable. Bump attempts so the worker gives up instead of re-picking
    // it on every poll forever.
    await Call.updateOne(
      { _id: call._id },
      { $set: { gradeError: 'No transcript' }, $inc: { gradeAttempts: 1 } }
    );
    return { ok: false, error: 'No transcript' };
  }

  // Claim the call so only one worker pays Sarvam to grade it. The webhook fast-path
  // and the scheduler batch both target `grade.score: null` calls; a fresh lease blocks
  // the loser, a stale lease (crashed mid-grade) is reclaimable after GRADE_LEASE_MS.
  const claimed = await Call.findOneAndUpdate(
    {
      _id: call._id,
      'grade.score': null,
      $or: [{ gradeStartedAt: null }, { gradeStartedAt: { $lt: new Date(Date.now() - GRADE_LEASE_MS) } }],
    },
    { $set: { gradeStartedAt: new Date() } }
  );
  if (!claimed) return { ok: false, skipped: true, reason: 'already grading or graded' };

  const { pos, total } = await positionInJourney(call);
  call._pos = pos;
  call._total = total;

  const r = await gradeOne(call);

  if (!r.parsed) {
    const error = r.error || 'unparseable JSON';
    // Release the lease so the next poll can retry (until attempts hit the cap).
    await Call.updateOne(
      { _id: call._id },
      { $set: { gradeError: error.slice(0, 200), gradeStartedAt: null }, $inc: { gradeAttempts: 1 } }
    );
    return { ok: false, error };
  }

  await Call.updateOne(
    { _id: call._id },
    { $set: { grade: toGrade(r.parsed), gradeError: null, gradeStartedAt: null }, $inc: { gradeAttempts: 1 } }
  );
  return { ok: true, score: r.parsed.total, usage: r.usage };
}

/**
 * Grade the next batch of won calls that are transcribed but not yet scored.
 * The worker's entry point. Bounded concurrency — Sarvam rate-limits.
 */
async function gradePending({ limit = 10, concurrency = 3 } = {}) {
  if (!isConfigured()) return { ok: 0, failed: 0, skipped: true };

  // Grade EVERY transcribed call, whatever its outcome — won, lost or open. A rep's
  // day is all their calls, not just the ones that happened to close, and grading the
  // lost/open ones is what surfaces "why we lose" and how someone handles a call that
  // did NOT convert. Scope is set upstream by what gets transcribed (TRANSCRIBE_SCOPE).
  const pending = await Call.find({
    transcriptionStatus: 'done',
    'grade.score': null,
    // `$not: $gte` NOT `$lt`: a call graded before this field existed has no
    // gradeAttempts at all, and `$lt` skips missing fields — so `$lt` would render
    // the entire historical backlog invisible to the worker. `$not $gte` matches
    // "under the cap OR field absent", which is what we actually mean.
    gradeAttempts: { $not: { $gte: MAX_ATTEMPTS } },
  })
    .sort({ startedAt: -1 }) // newest first — today's calls get scored before old backlog
    .limit(limit);

  let ok = 0;
  let failed = 0;
  let cursor = 0;

  async function worker() {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      if (idx >= pending.length) return;
      const r = await gradeCall(pending[idx]);
      if (r.ok) ok += 1;
      else failed += 1;
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));
  return { ok, failed, processed: pending.length };
}

module.exports = {
  isConfigured,
  gradeOne,
  gradeCall,
  gradePending,
  toGrade,
  transcriptText,
  SYSTEM,
  MODEL,
  MAX_ATTEMPTS,
};
