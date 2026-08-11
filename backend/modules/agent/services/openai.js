// The OpenAI chat-completions client behind the ask-the-data agent.
//
// Shaped like modules/calls/services/grader.js on purpose: module-level env
// config, an `isConfigured()` the callers check first, plain `fetch` (no SDK —
// the two other providers in this codebase don't use one either), bounded
// retries, and every request metered whether it succeeded or not.
//
// PROVIDER FAULT vs REQUEST FAULT
// -------------------------------
// Same distinction the grader draws. A 500 from OpenAI or a rate limit is worth
// retrying; a malformed request or an unknown model will fail identically every
// time and should surface immediately with something the admin can act on.

const usage = require('../../calls/services/apiUsage');

const API_URL = 'https://api.openai.com/v1/chat/completions';

const {
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-5',
  // gpt-5 reasons before it answers. 'low' is the right default here: the hard
  // part of this job is picking the right tool and reading the result, not deep
  // deliberation, and every reasoning token is billed as output. Raise it if the
  // multi-hop questions start coming back shallow.
  OPENAI_REASONING_EFFORT = 'low',
  OPENAI_MAX_OUTPUT_TOKENS = '4000',
} = process.env;

const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 120000;

function isConfigured() {
  return Boolean(OPENAI_API_KEY);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One chat-completions round trip.
 *
 * @param {Array} messages   the conversation so far, OpenAI message objects
 * @param {Array} tools      tool schemas the model may call
 * @returns {Promise<{ok: boolean, message?: object, finishReason?: string, error?: string, retryable?: boolean}>}
 */
async function chat(messages, tools, attempt = 0, { withReasoning = true } = {}) {
  if (!isConfigured()) {
    return { ok: false, error: 'OPENAI_API_KEY is not set on the server.', retryable: false };
  }

  const body = {
    model: OPENAI_MODEL,
    messages,
    // `max_completion_tokens`, not `max_tokens`: the reasoning models rejected the
    // older name, and the budget has to cover hidden reasoning tokens as well as
    // the visible answer.
    max_completion_tokens: Number(OPENAI_MAX_OUTPUT_TOKENS) || 4000,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  // Sent separately so it can be dropped and retried without it — see below.
  if (withReasoning && OPENAI_REASONING_EFFORT) {
    body.reasoning_effort = OPENAI_REASONING_EFFORT;
  }
  // NOTE: no `temperature`. The reasoning models accept only the default, and
  // sending 0.2 (as the Sarvam grader does) is a 400 rather than a nudge.

  let res;
  let json;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    json = text ? JSON.parse(text) : {};
  } catch (err) {
    usage.record('openai', { ok: false });
    if (attempt < MAX_RETRIES) {
      await sleep(1500 * (attempt + 1));
      return chat(messages, tools, attempt + 1, { withReasoning });
    }
    return { ok: false, error: `Could not reach OpenAI: ${err.message}`, retryable: true };
  }

  if (!res.ok) {
    usage.record('openai', { ok: false });
    const message = (json.error && json.error.message) || `HTTP ${res.status}`;

    // An account or model that does not support `reasoning_effort` answers 400
    // naming the parameter. Drop it once and try again rather than making the
    // whole feature depend on which tier the key is on — the same shape as the
    // transcriber's scribe_v2 -> scribe_v1 fallback.
    if (res.status === 400 && withReasoning && /reasoning_effort/i.test(message)) {
      return chat(messages, tools, attempt, { withReasoning: false });
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < MAX_RETRIES) {
      await sleep(1500 * (attempt + 1));
      return chat(messages, tools, attempt + 1, { withReasoning });
    }
    return { ok: false, error: `OpenAI: ${message}`, retryable };
  }

  const u = json.usage || {};
  usage.record('openai', {
    ok: true,
    promptTokens: u.prompt_tokens,
    completionTokens: u.completion_tokens,
    totalTokens: u.total_tokens,
  });

  const choice = (json.choices && json.choices[0]) || null;
  if (!choice || !choice.message) {
    return { ok: false, error: 'OpenAI returned no message.', retryable: false };
  }

  return {
    ok: true,
    message: choice.message,
    finishReason: choice.finish_reason,
    tokens: {
      prompt: u.prompt_tokens || 0,
      completion: u.completion_tokens || 0,
      total: u.total_tokens || 0,
    },
  };
}

module.exports = { chat, isConfigured, model: OPENAI_MODEL };
