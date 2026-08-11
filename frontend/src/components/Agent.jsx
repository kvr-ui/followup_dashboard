// The "Ask" tab — a chat box over the dashboard's own data.
//
// The thread lives here and in localStorage, and the whole of it is posted back
// on every turn: the server keeps no session, so a refresh loses nothing and two
// tabs never fight over one conversation.
//
// THE TRACE IS NOT A DEBUG PANEL
// Every answer ships with the list of tools that produced it, and for a
// hand-written aggregation the exact pipeline that ran — owner filter included.
// A number on a sales dashboard that nobody can check is a number nobody will
// act on, and this is how it gets checked. It is collapsed by default and one
// click from open, which is the right ratio for something you need rarely and
// absolutely when you need it.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { renderMarkdown } from '../miniMarkdown';

const THREAD_KEY = 'fd_agent_thread';

// Openers, so the first thing a user sees is what this can actually answer
// rather than an empty box. Split by role because half of them would 403 a rep.
const ADMIN_STARTERS = [
  'How are we doing this month — deals, revenue and win rate?',
  'Which lead source closes the most deals, and what does each one cost us?',
  'Which Meta campaign has the best cost per closed deal in the last 30 days?',
  'Who has a pending installment balance over ₹20,000?',
  'What are the top reasons we lose deals, and has that changed recently?',
];

const REP_STARTERS = [
  'How many of my deals closed this month?',
  'What are my call grades looking like?',
  'Which of my leads still owe money?',
  'Why am I losing deals — what are the top reasons?',
  'Which of my follow-ups are overdue?',
];

function loadThread() {
  try {
    const raw = localStorage.getItem(THREAD_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

/** One tool call, as a row in the "what it looked at" panel. */
function TraceRow({ step }) {
  const args = Object.entries(step.args || {}).filter(
    ([, v]) => v !== undefined && v !== null && v !== ''
  );

  return (
    <li className={step.ok ? 'agent-trace-row' : 'agent-trace-row failed'}>
      <div className="agent-trace-head">
        <code>{step.tool}</code>
        <span className="subtle">
          {step.rows != null ? `${step.rows} row${step.rows === 1 ? '' : 's'} · ` : ''}
          {fmtMs(step.ms)}
        </span>
      </div>

      {args.length > 0 && (
        <div className="agent-trace-args">
          {args.map(([k, v]) => (
            <span className="agent-arg" key={k}>
              {k}: <b>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</b>
            </span>
          ))}
        </div>
      )}

      {/* The pipeline that actually ran, owner filter and row cap included. */}
      {step.pipeline && (
        <pre className="agent-pipeline">{JSON.stringify(step.pipeline, null, 1)}</pre>
      )}

      {step.error && <div className="agent-trace-error">{step.error}</div>}
    </li>
  );
}

function Message({ msg }) {
  const [showTrace, setShowTrace] = useState(false);

  if (msg.role === 'user') {
    return (
      <div className="agent-msg user">
        <div className="agent-bubble">{msg.content}</div>
      </div>
    );
  }

  const steps = msg.trace || [];
  const failed = steps.filter((s) => !s.ok).length;

  return (
    <div className="agent-msg assistant">
      <div className="agent-bubble">
        {msg.error ? (
          <p className="error">{msg.content}</p>
        ) : (
          renderMarkdown(msg.content)
        )}

        {steps.length > 0 && (
          <div className="agent-trace">
            <button
              type="button"
              className="agent-trace-toggle"
              onClick={() => setShowTrace((v) => !v)}
            >
              {showTrace ? '▾' : '▸'} Looked at {steps.length} source
              {steps.length === 1 ? '' : 's'}
              {failed > 0 ? ` · ${failed} failed` : ''}
            </button>
            {showTrace && (
              <ul className="agent-trace-list">
                {steps.map((step, i) => (
                  <TraceRow step={step} key={i} />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Agent({ user }) {
  const isAdmin = user?.role === 'admin';
  const [thread, setThread] = useState(loadThread);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);

  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  const starters = useMemo(() => (isAdmin ? ADMIN_STARTERS : REP_STARTERS), [isAdmin]);

  // Is the assistant even usable? Asked once, so an unconfigured server says so
  // up front instead of after someone has typed a question.
  useEffect(() => {
    let cancelled = false;
    api('/api/agent/status')
      .then((r) => {
        if (!cancelled) setStatus(r);
      })
      .catch((err) => {
        if (!cancelled) setStatus({ configured: false, error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(THREAD_KEY, JSON.stringify(thread));
    } catch {
      // A full quota is not worth breaking the conversation over.
    }
  }, [thread]);

  // Keep the newest turn in view as the answer arrives.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread, busy]);

  const send = useCallback(
    async (text) => {
      const question = text.trim();
      if (!question || busy) return;

      // Only the plain turns go back as history — the server strips tool traffic
      // anyway, and sending it would just pay for tokens twice.
      const history = thread
        .filter((m) => !m.error)
        .map((m) => ({ role: m.role, content: m.content }));

      setThread((t) => [...t, { role: 'user', content: question }]);
      setInput('');
      setBusy(true);

      try {
        const res = await api('/api/agent/chat', {
          method: 'POST',
          body: { message: question, history },
        });
        setThread((t) => [
          ...t,
          {
            role: 'assistant',
            content: res.answer || '(no answer)',
            trace: res.trace || [],
            exhausted: res.exhausted,
          },
        ]);
      } catch (err) {
        setThread((t) => [
          ...t,
          { role: 'assistant', content: err.message, error: true, trace: [] },
        ]);
      } finally {
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [busy, thread]
  );

  const onKeyDown = (e) => {
    // Enter sends, Shift+Enter is a newline — the convention every chat box uses.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  const clear = () => {
    setThread([]);
    localStorage.removeItem(THREAD_KEY);
  };

  const unconfigured = status && status.configured === false;

  return (
    <div className="agent-wrap">
      <div className="agent-head">
        <div>
          <h2>Ask</h2>
          <p className="subtle">
            Questions about your{isAdmin ? '' : ' own'} leads, calls, deals
            {isAdmin ? ', ad spend' : ''} and follow-ups. It reads the data — it never changes
            anything.
          </p>
        </div>
        {thread.length > 0 && (
          <button type="button" onClick={clear} disabled={busy}>
            New conversation
          </button>
        )}
      </div>

      {unconfigured && (
        <div className="panel agent-unconfigured">
          <p className="error">The assistant is not switched on for this server.</p>
          <p className="subtle">
            Set <code>OPENAI_API_KEY</code> in the backend environment and restart. Everything
            else on the dashboard works without it.
          </p>
        </div>
      )}

      <div className="agent-thread" ref={scrollRef}>
        {thread.length === 0 && !unconfigured && (
          <div className="agent-empty">
            <p className="subtle">Ask anything about the data. For example:</p>
            <div className="agent-starters">
              {starters.map((s) => (
                <button type="button" className="agent-starter" key={s} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {thread.map((msg, i) => (
          <Message msg={msg} key={i} />
        ))}

        {busy && (
          <div className="agent-msg assistant">
            <div className="agent-bubble agent-thinking">
              <span className="agent-dot" />
              <span className="agent-dot" />
              <span className="agent-dot" />
              <span className="subtle">Looking it up…</span>
            </div>
          </div>
        )}
      </div>

      <form
        className="agent-composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          ref={inputRef}
          rows={2}
          value={input}
          placeholder={unconfigured ? 'Unavailable' : 'Ask about your data…'}
          disabled={busy || unconfigured}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="submit" disabled={busy || unconfigured || !input.trim()}>
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </form>
    </div>
  );
}
