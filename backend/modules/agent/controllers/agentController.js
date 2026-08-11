// POST /api/agent/chat — one turn of the ask-the-data agent.
//
// The loop is: send the conversation, run whatever tools the model asks for, send
// the results back, repeat until it answers in prose or hits the round cap.
//
// STATELESS ON THE SERVER
// -----------------------
// The client sends the whole thread each turn and gets the whole thread back.
// No session store, no per-user memory to expire, and a browser refresh loses
// nothing the client did not choose to lose. The cost is prompt tokens on a long
// thread, which is what TRIM_TO_MESSAGES below is for.
//
// SCOPE
// -----
// `req.user` comes from the real `authenticate` middleware, and the scope handed
// to the tools is derived from it here — never from anything in the request body.
// A rep can send whatever JSON they like; they still only reach their own rows.

const openai = require('../services/openai');
const { systemPrompt } = require('../services/prompt');
const { toolSchemas, dispatch } = require('../services/tools');

// How many tool rounds one question may take. Enough for "ad spend → the leads it
// bought → the deals they closed → the calls on those deals", which is four, with
// room to recover from a mistyped filter. A model that has not answered by then is
// looping, and the honest response is to say so.
const MAX_ROUNDS = Number(process.env.AGENT_MAX_ROUNDS) || 8;

// How much history to carry. Older turns are dropped rather than summarised: the
// tool results are the expensive part and a stale one is worse than absent —
// re-running the tool is cheap and current.
const TRIM_TO_MESSAGES = 40;

// A question longer than this is a paste, not a question.
const MAX_QUESTION_CHARS = 4000;

// Per-user rate limit. The same shape as modules/ads/middleware/rateLimit.js:
// in-memory, single-process, good enough to stop a stuck client burning the
// account. Keyed by user id, not IP — this endpoint is behind auth.
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX = Number(process.env.AGENT_RATE_MAX) || 20;
const hits = new Map();

function rateLimited(userId) {
  const now = Date.now();
  const fresh = (hits.get(userId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (fresh.length >= RATE_MAX) {
    hits.set(userId, fresh);
    return true;
  }
  fresh.push(now);
  hits.set(userId, fresh);
  // Opportunistic sweep so the map cannot grow without bound in a long-lived process.
  if (hits.size > 500) {
    for (const [key, times] of hits) {
      if (!times.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(key);
    }
  }
  return false;
}

/**
 * Rebuild the OpenAI message list from what the client sent.
 *
 * Only `role` and `content` are carried across, and only for user and assistant
 * turns. The tool traffic from previous turns is deliberately NOT replayed: it is
 * the bulk of the tokens, it goes stale, and the model can always ask again.
 */
function sanitiseHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-TRIM_TO_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_QUESTION_CHARS) }));
}

/** Tool results go back as JSON strings; keep one from swallowing the window. */
function serialiseResult(result) {
  const text = JSON.stringify(result);
  const CAP = 60000;
  if (text.length <= CAP) return text;
  return JSON.stringify({
    ok: true,
    truncated: true,
    note: `The result was ${text.length} characters and has been cut off. Re-run it as an aggregation, or with a smaller limit.`,
    head: text.slice(0, CAP),
  });
}

async function chat(req, res) {
  const question = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!question) {
    return res.status(400).json({ success: false, message: 'Ask a question.' });
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return res
      .status(400)
      .json({ success: false, message: `Questions are limited to ${MAX_QUESTION_CHARS} characters.` });
  }
  if (!openai.isConfigured()) {
    return res.status(503).json({
      success: false,
      message: 'The assistant is not configured on this server — OPENAI_API_KEY is unset.',
    });
  }
  if (rateLimited(String(req.user._id))) {
    return res.status(429).json({
      success: false,
      message: `Too many questions — the limit is ${RATE_MAX} every ${RATE_WINDOW_MS / 60000} minutes.`,
    });
  }

  // Everything the tools are allowed to see, derived from the authenticated user
  // and nothing else.
  const scope = {
    isAdmin: req.user.role === 'admin',
    ownerEmail: (req.user.ownerEmail || '').toLowerCase(),
  };
  const ctx = { scope, user: req.user };

  const messages = [
    { role: 'system', content: systemPrompt(scope, req.user) },
    ...sanitiseHistory(req.body?.history),
    { role: 'user', content: question },
  ];

  const tools = toolSchemas(scope);
  // What the model looked at, surfaced to the UI. An answer whose provenance a
  // user cannot inspect is a number nobody will act on.
  const trace = [];
  let tokens = { prompt: 0, completion: 0, total: 0 };

  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const reply = await openai.chat(messages, tools);
      if (!reply.ok) {
        return res.status(502).json({ success: false, message: reply.error, trace });
      }
      if (reply.tokens) {
        tokens = {
          prompt: tokens.prompt + reply.tokens.prompt,
          completion: tokens.completion + reply.tokens.completion,
          total: tokens.total + reply.tokens.total,
        };
      }

      const { message } = reply;
      const calls = message.tool_calls || [];

      if (!calls.length) {
        return res.json({
          success: true,
          answer: message.content || '',
          trace,
          rounds: round + 1,
          tokens,
          model: openai.model,
        });
      }

      // The assistant turn carrying the tool calls has to go back verbatim, or the
      // tool results that follow have nothing to attach to.
      messages.push(message);

      // Run this round's calls together. They are all reads, so there is no
      // ordering to preserve, and a question that needs three lookups should not
      // cost three sequential round trips.
      const results = await Promise.all(
        calls.map(async (call) => {
          let args = {};
          let parseError = null;
          try {
            args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          } catch (err) {
            parseError = `Arguments were not valid JSON: ${err.message}`;
          }

          const started = Date.now();
          const result = parseError
            ? { ok: false, error: parseError }
            : await dispatch(call.function.name, args, ctx);

          trace.push({
            tool: call.function.name,
            args,
            ok: result.ok !== false,
            error: result.ok === false ? result.error : undefined,
            // Enough for the UI to show "12 rows in 340ms" without shipping the
            // rows themselves back a second time.
            rows: result.returned ?? result.rowCount ?? undefined,
            ms: Date.now() - started,
            // The aggregation tool echoes the pipeline that actually ran, owner
            // filter included. That echo is how a rep can see for themselves that
            // the scoping happened, so it is the one payload worth surfacing.
            pipeline: result.pipelineRun,
          });

          return { call, result };
        })
      );

      for (const { call, result } of results) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: serialiseResult(result),
        });
      }
    }

    // Out of rounds. Say what happened rather than returning a half-answer.
    return res.json({
      success: true,
      answer:
        `I could not finish that within ${MAX_ROUNDS} steps of looking things up. ` +
        `Try asking it in smaller pieces — the tools I ran are listed below.`,
      trace,
      rounds: MAX_ROUNDS,
      exhausted: true,
      tokens,
      model: openai.model,
    });
  } catch (err) {
    console.error('[agent] chat failed:', err);
    return res.status(500).json({ success: false, message: 'The assistant hit an error.', trace });
  }
}

/** GET /api/agent/status — whether the assistant is usable, for the UI to check on load. */
function status(req, res) {
  res.json({
    success: true,
    configured: openai.isConfigured(),
    model: openai.model,
    isAdmin: req.user.role === 'admin',
    tools: toolSchemas({
      isAdmin: req.user.role === 'admin',
      ownerEmail: req.user.ownerEmail,
    }).map((t) => t.function.name),
  });
}

module.exports = { chat, status };
