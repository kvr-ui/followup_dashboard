// The AI spend meter: what we sent to Sarvam and ElevenLabs, and what is left to spend.
//
// Two halves, and they answer different questions:
//   record()/summary() — OUR ledger. Every billable request is counted as it happens
//                        (see models/ApiUsage.js for why a derived sum is not enough).
//   balances()         — THEIR ledger, read live from the provider so the dashboard
//                        shows the number the account is actually judged on.
//
// Nothing here may ever break a transcription or a grade. record() is fire-and-forget
// and swallows its own errors; a metering failure is a missing number, not a lost call.

const ApiUsage = require('../models/ApiUsage');
const Call = require('../models/Call');

// ElevenLabs is the only one of the two with a balance endpoint. Sarvam has none —
// /v1/wallet/balance, /v1/usage, /v1/credits and /v1/me all 404 — so the Sarvam card
// shows our own ledger and, if SARVAM_TOKEN_ALLOWANCE is set, what is left of it.
const ELEVENLABS_SUBSCRIPTION_URL = 'https://api.elevenlabs.io/v1/user/subscription';
const BALANCE_TTL_MS = 5 * 60 * 1000;

let balanceCache = { at: 0, data: null };

/** Local (IST) 'YYYY-MM-DD' — the day boundary the rest of the dashboard uses. */
function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function daysAgoKey(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dayKey(d);
}

/**
 * Count one billable request. Fire-and-forget by design: callers must NOT await it and
 * it must never throw, so a metering hiccup cannot fail the work that was paid for.
 *
 * @param {'sarvam'|'elevenlabs'} provider
 * @param {{ok?:boolean, promptTokens?:number, completionTokens?:number,
 *           totalTokens?:number, audioSeconds?:number}} delta
 */
function record(provider, delta = {}) {
  const inc = { requests: 1 };
  if (delta.ok === false) inc.failures = 1;

  const prompt = Number(delta.promptTokens) || 0;
  const completion = Number(delta.completionTokens) || 0;
  const total = Number(delta.totalTokens) || prompt + completion;
  const audio = Number(delta.audioSeconds) || 0;

  if (prompt) inc.promptTokens = prompt;
  if (completion) inc.completionTokens = completion;
  if (total) inc.totalTokens = total;
  if (audio) inc.audioSeconds = Math.round(audio);

  ApiUsage.updateOne(
    { provider, day: dayKey() },
    { $inc: inc, $set: { lastAt: new Date() } },
    { upsert: true }
  ).catch((err) => console.warn(`usage meter (${provider}) failed:`, err.message));
}

const ZERO = {
  requests: 0,
  failures: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  audioSeconds: 0,
};

function addRow(acc, row) {
  for (const k of Object.keys(ZERO)) acc[k] += row[k] || 0;
  return acc;
}

/**
 * Our ledger for one provider: today / last 7 / last 30 / all time, plus a per-day
 * series for the chart. `days` is how much of the series to return.
 */
async function summary(provider, { days = 30 } = {}) {
  const rows = await ApiUsage.find({ provider }).sort({ day: 1 }).lean();

  const today = dayKey();
  const from7 = daysAgoKey(6); // today included
  const from30 = daysAgoKey(29);

  const totals = {
    today: { ...ZERO },
    last7: { ...ZERO },
    last30: { ...ZERO },
    allTime: { ...ZERO },
  };

  for (const row of rows) {
    addRow(totals.allTime, row);
    if (row.day >= from30) addRow(totals.last30, row);
    if (row.day >= from7) addRow(totals.last7, row);
    if (row.day === today) addRow(totals.today, row);
  }

  const fromSeries = daysAgoKey(days - 1);
  const daily = rows
    .filter((r) => r.day >= fromSeries)
    .map((r) => ({
      day: r.day,
      requests: r.requests || 0,
      failures: r.failures || 0,
      promptTokens: r.promptTokens || 0,
      completionTokens: r.completionTokens || 0,
      totalTokens: r.totalTokens || 0,
      audioSeconds: r.audioSeconds || 0,
    }));

  return { totals, daily, since: rows.length ? rows[0].day : null };
}

/**
 * What the pipeline has produced since day one, straight from the calls.
 *
 * The meter above only knows about requests made after it was deployed, so on the first
 * day every card would read zero and look broken. These numbers are the floor: work we
 * can prove we paid for, even though the exact request count (retries included) is lost.
 */
async function historicalTotals() {
  const [audio] = await Call.aggregate([
    { $match: { 'transcript.durationSec': { $gt: 0 } } },
    {
      $group: {
        _id: null,
        calls: { $sum: 1 },
        seconds: { $sum: '$transcript.durationSec' },
      },
    },
  ]);

  const gradedCalls = await Call.countDocuments({ 'grade.score': { $ne: null } });

  return {
    transcribedCalls: audio?.calls || 0,
    transcribedSeconds: Math.round(audio?.seconds || 0),
    gradedCalls,
  };
}

/**
 * ElevenLabs' own balance: characters used against the plan's quota, and when it resets.
 * Cached for BALANCE_TTL_MS — the dashboard polls, the provider rate-limits.
 *
 * The API key needs the `user_read` permission. Without it ElevenLabs answers 401 with
 * `missing_permissions`, which is a settings problem on their side and not something we
 * can retry our way out of — so it is passed through to the UI as an actionable hint
 * rather than being swallowed as "unavailable".
 */
async function elevenLabsBalance({ force = false } = {}) {
  if (!process.env.ELEVENLABS_API_KEY) {
    return { available: false, reason: 'ELEVENLABS_API_KEY is not set' };
  }
  if (!force && balanceCache.data && Date.now() - balanceCache.at < BALANCE_TTL_MS) {
    return balanceCache.data;
  }

  let data;
  try {
    const res = await fetch(ELEVENLABS_SUBSCRIPTION_URL, {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      const detail = json.detail || {};
      data = {
        available: false,
        reason:
          detail.status === 'missing_permissions'
            ? 'The ElevenLabs API key cannot read the account balance. Enable the ' +
              '"User: Read" permission on the key in ElevenLabs → Developers → API Keys.'
            : detail.message || json.message || `ElevenLabs returned HTTP ${res.status}`,
      };
    } else {
      const used = json.character_count ?? 0;
      const limit = json.character_limit ?? null;
      data = {
        available: true,
        tier: json.tier || null,
        status: json.status || null,
        used,
        limit,
        remaining: limit === null ? null : Math.max(0, limit - used),
        percentUsed: limit ? Math.round((used / limit) * 1000) / 10 : null,
        resetsAt: json.next_character_count_reset_unix
          ? new Date(json.next_character_count_reset_unix * 1000)
          : null,
      };
    }
  } catch (err) {
    data = { available: false, reason: `Could not reach ElevenLabs: ${err.message}` };
  }

  balanceCache = { at: Date.now(), data };
  return data;
}

/**
 * Sarvam publishes no balance endpoint, so "how much is left" can only be answered
 * against an allowance someone types in. Set SARVAM_TOKEN_ALLOWANCE to the token budget
 * bought for the account and the card shows what remains of it; leave it unset and the
 * card honestly shows usage only.
 */
function sarvamBalance(allTimeTokens) {
  if (!process.env.SARVAM_API_KEY) {
    return { available: false, reason: 'SARVAM_API_KEY is not set' };
  }

  const allowance = Number(process.env.SARVAM_TOKEN_ALLOWANCE) || 0;
  if (!allowance) {
    return {
      available: false,
      reason:
        'Sarvam does not expose a balance API. Set SARVAM_TOKEN_ALLOWANCE to your ' +
        'purchased token budget to track what is left, or check dashboard.sarvam.ai.',
    };
  }

  return {
    available: true,
    unit: 'tokens',
    used: allTimeTokens,
    limit: allowance,
    remaining: Math.max(0, allowance - allTimeTokens),
    percentUsed: Math.round((allTimeTokens / allowance) * 1000) / 10,
    // Counted from OUR meter, so it only covers requests made since it was deployed.
    approximate: true,
  };
}

module.exports = {
  record,
  summary,
  historicalTotals,
  elevenLabsBalance,
  sarvamBalance,
  dayKey,
};
