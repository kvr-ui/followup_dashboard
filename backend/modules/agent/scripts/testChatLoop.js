// End-to-end test of the agent's tool-calling loop, with the model stubbed.
//
//   node modules/agent/scripts/testChatLoop.js
//
// Needs MONGO_URI (the tools really do query), but NOT an OpenAI key: the
// provider is replaced with a scripted stub, so this exercises the part we wrote
// — round handling, tool dispatch, scope injection, the trace, the round cap —
// without paying for it or depending on a model behaving a particular way.
//
// What it is checking, in order of how much it would hurt to get wrong:
//   1. a sales rep cannot reach an admin tool, however the model asks
//   2. the assistant turn and its tool results are threaded back correctly, or
//      OpenAI rejects the next request outright
//   3. the loop terminates on the round cap instead of spending forever

require('dotenv').config();
const mongoose = require('mongoose');

const openai = require('../services/openai');
const { chat } = require('../controllers/agentController');
const User = require('../../../models/User');

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) passed += 1;
  else failures.push(`${name}${detail ? `\n    ${detail}` : ''}`);
}

/**
 * Replace the provider with a scripted one.
 * `script` is an array of replies, consumed in order; each is either
 * `{tools: [{name, args}]}` or `{answer: '…'}`.
 */
function stubModel(script) {
  const seen = [];
  let i = 0;
  openai.chat = async (messages) => {
    seen.push(messages.map((m) => m.role));
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (step.answer) {
      return {
        ok: true,
        message: { role: 'assistant', content: step.answer },
        tokens: { prompt: 10, completion: 5, total: 15 },
      };
    }
    return {
      ok: true,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: step.tools.map((t, n) => ({
          id: `call_${i}_${n}`,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.args || {}) },
        })),
      },
      tokens: { prompt: 10, completion: 5, total: 15 },
    };
  };
  return { rounds: () => i, seen };
}

/** Drive the controller and capture what it answered. */
function call(user, body) {
  return new Promise((resolve) => {
    let status = 200;
    const res = {
      status(code) {
        status = code;
        return res;
      },
      json(payload) {
        resolve({ status, body: payload });
      },
    };
    chat({ user, body }, res);
  });
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/followup_dashboard');

  const admin = await User.findOne({ role: 'admin' }).lean();
  const rep = await User.findOne({ role: { $ne: 'admin' }, ownerEmail: { $ne: null } }).lean();
  if (!admin) throw new Error('No admin user in the database to test with.');

  const realChat = openai.chat;
  const realConfigured = openai.isConfigured;
  // The controller refuses to start without a key; the stub is the key here.
  openai.isConfigured = () => true;

  // ── 1. A single tool call, then an answer ─────────────────────────────────
  {
    const stub = stubModel([
      { tools: [{ name: 'deal_outcomes' }] },
      { answer: 'You have won 184 deals.' },
    ]);
    const { status, body } = await call(admin, { message: 'How many deals have we won?' });

    check('a tool call then an answer returns 200', status === 200, `got ${status}`);
    check('the answer is passed through', body.answer === 'You have won 184 deals.');
    check('the trace names the tool', body.trace?.[0]?.tool === 'deal_outcomes');
    check('the trace records the tool succeeded', body.trace?.[0]?.ok === true, body.trace?.[0]?.error);
    check('it took two rounds', body.rounds === 2, `rounds=${body.rounds}`);
    check('tokens are totalled across rounds', body.tokens?.total === 30, `total=${body.tokens?.total}`);

    // The second request must carry: system, user, the assistant turn holding
    // the tool_calls, and the tool result. Drop either of the last two and
    // OpenAI 400s on the next call.
    const second = stub.seen[1];
    check(
      'the assistant turn and its tool result are threaded back',
      second?.[second.length - 2] === 'assistant' && second?.[second.length - 1] === 'tool',
      JSON.stringify(second)
    );
  }

  // ── 2. Several tools in one round ─────────────────────────────────────────
  {
    stubModel([
      {
        tools: [
          { name: 'deal_outcomes' },
          { name: 'call_stats' },
          { name: 'query_deals', args: { outcome: 'won', limit: 2 } },
        ],
      },
      { answer: 'Here is the summary.' },
    ]);
    const { body } = await call(admin, { message: 'Give me everything.' });
    check('all three tools ran', body.trace?.length === 3, `trace=${body.trace?.length}`);
    check('all three succeeded', body.trace?.every((t) => t.ok), JSON.stringify(body.trace));
  }

  // ── 3. A rep cannot reach an admin tool ───────────────────────────────────
  if (rep) {
    stubModel([
      { tools: [{ name: 'ad_summary' }] },
      { answer: 'I do not have access to ad spend.' },
    ]);
    const { body } = await call(rep, { message: 'What did we spend on ads?' });
    check('the admin tool call is recorded as failed', body.trace?.[0]?.ok === false);
    check(
      'the refusal explains it is admin-only',
      /admin-only/i.test(body.trace?.[0]?.error || ''),
      body.trace?.[0]?.error
    );
  } else {
    failures.push('no sales user with an ownerEmail in the database — rep scoping was NOT tested');
  }

  // ── 4. A rep's aggregation is scoped whatever they ask for ────────────────
  if (rep) {
    stubModel([
      {
        tools: [
          {
            name: 'run_aggregation',
            args: {
              collection: 'deals',
              pipeline: [{ $group: { _id: '$ownerEmail', n: { $sum: 1 } } }],
            },
          },
        ],
      },
      { answer: 'Done.' },
    ]);
    const { body } = await call(rep, { message: 'Show me every rep\'s deals.' });
    const step = body.trace?.[0];
    const first = step?.pipeline?.[0];
    check('the owner filter was prepended', Boolean(first?.$match?.ownerEmail), JSON.stringify(first));
    // The echo renders the regex as its source, where the dots are escaped —
    // unescape before comparing, or this fails on a correct filter.
    check(
      'the echoed filter names this rep, readably',
      String(first?.$match?.ownerEmail || '')
        .replace(/\\/g, '')
        .includes(rep.ownerEmail),
      JSON.stringify(first)
    );
  }

  // ── 5. A bad tool name fails the call, not the conversation ───────────────
  {
    stubModel([{ tools: [{ name: 'drop_everything' }] }, { answer: 'That tool does not exist.' }]);
    const { status, body } = await call(admin, { message: 'Delete it all.' });
    check('an unknown tool still returns 200', status === 200, `got ${status}`);
    check('the unknown tool is marked failed', body.trace?.[0]?.ok === false);
  }

  // ── 6. Malformed tool arguments ───────────────────────────────────────────
  {
    let i = 0;
    openai.chat = async () => {
      i += 1;
      if (i === 1) {
        return {
          ok: true,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_bad',
                type: 'function',
                function: { name: 'query_deals', arguments: '{not json' },
              },
            ],
          },
          tokens: { prompt: 1, completion: 1, total: 2 },
        };
      }
      return { ok: true, message: { role: 'assistant', content: 'Let me try again.' }, tokens: { prompt: 1, completion: 1, total: 2 } };
    };
    const { status, body } = await call(admin, { message: 'Something.' });
    check('malformed arguments do not crash the turn', status === 200, `got ${status}`);
    check('the parse failure is reported to the model', /not valid JSON/i.test(body.trace?.[0]?.error || ''));
  }

  // ── 7. The round cap ──────────────────────────────────────────────────────
  {
    // A model that only ever calls tools. Without the cap this never returns.
    stubModel([{ tools: [{ name: 'call_stats' }] }]);
    const { body } = await call(admin, { message: 'Loop forever.' });
    check('the loop stops at the round cap', body.exhausted === true, JSON.stringify(body).slice(0, 200));
    check('it says it could not finish', /could not finish/i.test(body.answer || ''));
  }

  // ── 8. Input validation ───────────────────────────────────────────────────
  {
    const { status } = await call(admin, { message: '   ' });
    check('an empty question is rejected', status === 400, `got ${status}`);
  }

  // ── 9. Rate limiting ──────────────────────────────────────────────────────
  {
    stubModel([{ answer: 'ok' }]);
    let limited = false;
    // The limit is 20 per 5 minutes and earlier cases already spent some of it.
    for (let n = 0; n < 30; n += 1) {
      const { status } = await call(admin, { message: `q${n}` });
      if (status === 429) {
        limited = true;
        break;
      }
    }
    check('a runaway client is rate limited', limited);
  }

  openai.chat = realChat;
  openai.isConfigured = realConfigured;
  await mongoose.disconnect();

  if (failures.length) {
    console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
    failures.forEach((f) => console.error(`  ✗ ${f}\n`));
    process.exit(1);
  }
  console.log(`${passed} chat-loop tests passed.`);
})().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
