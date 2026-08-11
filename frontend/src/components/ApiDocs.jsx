import { useMemo, useState } from 'react';
import CopyButton from './CopyButton';
import { api, getToken } from '../api';
import {
  BASE_HINT,
  GROUPS,
  authLabel,
  curlFor,
  fetchFor,
} from '../apiDocs';

/**
 * The API Docs tab: every endpoint this backend serves, with a copyable curl,
 * the equivalent fetch(), and a live "Run" button.
 *
 * "Run" is the point of putting this in the dashboard rather than in a README.
 * It fires the real request with the session's real token, so the example you
 * are reading and the response you see cannot drift apart. It is offered for GET
 * only — a docs page must not be a way to POST a sync or delete a user by
 * accident, and the write examples are copyable instead.
 */
export default function ApiDocs({ user }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(GROUPS[0].id);
  const [showToken, setShowToken] = useState(false);

  const origin = window.location.origin;
  const token = getToken() || '';

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GROUPS;
    return GROUPS.map((g) => ({
      ...g,
      endpoints: g.endpoints.filter((e) =>
        `${e.method} ${e.path} ${e.summary}`.toLowerCase().includes(q)
      ),
    })).filter((g) => g.endpoints.length > 0);
  }, [query]);

  const visible = query.trim() ? groups : groups.filter((g) => g.id === active);

  return (
    <div className="docs">
      <div className="docs-head">
        <div>
          <h2>API reference</h2>
          <p className="subtle">
            Every endpoint behind this dashboard. {BASE_HINT}
          </p>
        </div>
      </div>

      {/* ---- Where to fetch from, and with what ---- */}
      <div className="docs-start">
        <div className="docs-start-row">
          <span className="docs-start-label">Base URL</span>
          <code className="docs-code-inline">{origin}</code>
          <CopyButton text={origin} />
        </div>
        <div className="docs-start-row">
          <span className="docs-start-label">Auth header</span>
          <code className="docs-code-inline">Authorization: Bearer &lt;token&gt;</code>
        </div>
        <div className="docs-start-row">
          <span className="docs-start-label">Your token</span>
          {token ? (
            <>
              <code className="docs-code-inline docs-token">
                {showToken ? token : `${token.slice(0, 12)}…${token.slice(-6)}`}
              </code>
              <button type="button" className="docs-mini" onClick={() => setShowToken((v) => !v)}>
                {showToken ? 'Hide' : 'Reveal'}
              </button>
              <CopyButton text={token} title="Copy your token" />
            </>
          ) : (
            <span className="subtle">Not signed in.</span>
          )}
        </div>
        <div className="docs-start-row">
          <span className="docs-start-label">Your role</span>
          <span className={`badge ${user.role === 'admin' ? 'auth-admin' : 'auth-user'}`}>
            {user.role}
          </span>
          <span className="subtle">
            {user.role === 'admin'
              ? 'Every endpoint below is available to you.'
              : `Admin-only endpoints answer 403. The rest are scoped to ${user.ownerEmail || 'your owner email'} on the server.`}
          </span>
        </div>
        <p className="docs-warn">
          That token is your session. It carries lead PII, call recordings and transcripts — treat it
          like a password, and never paste it into anything you would not paste a password into.
        </p>
      </div>

      <div className="docs-toolbar">
        <input
          className="docs-search"
          placeholder="Search endpoints — try 'grades', 'sync', 'lead'…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query.trim() && (
          <button type="button" className="docs-mini" onClick={() => setQuery('')}>
            Clear
          </button>
        )}
      </div>

      {!query.trim() && (
        <nav className="docs-nav">
          {GROUPS.map((g) => (
            <button
              key={g.id}
              type="button"
              className={g.id === active ? 'docs-nav-item active' : 'docs-nav-item'}
              onClick={() => setActive(g.id)}
            >
              {g.title}
              <span className="docs-nav-count">{g.endpoints.length}</span>
            </button>
          ))}
        </nav>
      )}

      {visible.length === 0 && <p className="subtle">No endpoint matches “{query}”.</p>}

      {visible.map((group) => (
        <section key={group.id} className="docs-group">
          <h3>{group.title}</h3>
          <p className="docs-blurb">{group.blurb}</p>
          {group.endpoints.map((ep) => (
            <Endpoint key={`${ep.method} ${ep.path}`} ep={ep} origin={origin} token={token} />
          ))}
        </section>
      ))}
    </div>
  );
}

function Endpoint({ ep, origin, token }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('curl');
  const badge = authLabel(ep.auth);
  const snippets = useMemo(() => fetchFor(ep), [ep]);
  const curl = useMemo(() => curlFor(ep, origin, token), [ep, origin, token]);

  const snippet = tab === 'curl' ? curl : tab === 'app' ? snippets.inApp : snippets.raw;

  return (
    <article className={open ? 'docs-ep open' : 'docs-ep'}>
      <button type="button" className="docs-ep-head" onClick={() => setOpen((v) => !v)}>
        <span className={`docs-method m-${ep.method.toLowerCase()}`}>{ep.method}</span>
        <code className="docs-path">{ep.path}</code>
        <span className={`badge ${badge.cls}`}>{badge.text}</span>
        <span className="docs-ep-summary">{ep.summary}</span>
        <span className="docs-chev">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="docs-ep-body">
          {ep.note && <p className="docs-note">{ep.note}</p>}

          {ep.params && <ArgTable title="Path parameters" rows={ep.params} />}
          {ep.query && <ArgTable title="Query parameters" rows={ep.query} />}
          {ep.body && <ArgTable title="Request body (JSON)" rows={ep.body} />}
          {ep.headers && (
            <ArgTable title="Headers" rows={ep.headers.map(([n, d]) => [n, '', d])} noType />
          )}

          <div className="docs-block">
            <div className="docs-block-head">
              <div className="docs-tabs">
                {[
                  ['curl', 'curl'],
                  ['app', 'In this app'],
                  ['raw', 'fetch()'],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={tab === id ? 'docs-tab active' : 'docs-tab'}
                    onClick={() => setTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <CopyButton text={snippet} title="Copy request" />
            </div>
            <pre className="docs-code">{snippet}</pre>
            {tab === 'app' && (
              <p className="docs-hint">
                <code>api()</code> lives in <code>frontend/src/api.js</code> — it attaches the bearer
                token, throws on a non-2xx, and logs you out on a 401.
              </p>
            )}
          </div>

          <TryIt ep={ep} />

          <div className="docs-block">
            <div className="docs-block-head">
              <strong>Example response {ep.rawResponse ? '' : '(200)'}</strong>
              <CopyButton
                text={ep.rawResponse || JSON.stringify(ep.response, null, 2)}
                title="Copy response"
              />
            </div>
            <pre className="docs-code">
              {ep.rawResponse || JSON.stringify(ep.response, null, 2)}
            </pre>
          </div>

          {ep.errors && (
            <div className="docs-block">
              <div className="docs-block-head">
                <strong>Errors</strong>
              </div>
              <table className="docs-table">
                <tbody>
                  {ep.errors.map(([code, msg]) => (
                    <tr key={code + msg}>
                      <td className="docs-status">{code}</td>
                      <td>{msg}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {ep.source && (
            <p className="docs-source">
              Served by <code>{ep.source}</code>
            </p>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * Run the request for real.
 *
 * GET only, and the path is editable so you can change a filter and see what
 * comes back. Writes are documented but not runnable from here — see the note in
 * the component above.
 */
function TryIt({ ep }) {
  const [path, setPath] = useState(ep.example || ep.path);
  const [state, setState] = useState({ status: 'idle' });

  const runnable = ep.method === 'GET' && !ep.path.includes(':') && !ep.rawResponse;

  if (!runnable) {
    return (
      <p className="docs-hint">
        {ep.method === 'GET'
          ? ep.rawResponse
            ? 'Not runnable here — this endpoint answers with audio, not JSON.'
            : 'Not runnable here — fill in the path parameter and use the copied request.'
          : `Not runnable from the docs: ${ep.method} changes data. Copy the request above and run it deliberately.`}
      </p>
    );
  }

  async function run() {
    setState({ status: 'loading' });
    try {
      const json = await api(path);
      setState({ status: 'ok', json });
    } catch (err) {
      setState({ status: 'error', message: err.message });
    }
  }

  return (
    <div className="docs-block docs-try">
      <div className="docs-block-head">
        <strong>Try it</strong>
        <span className="subtle">runs against this server, with your token</span>
      </div>
      <div className="docs-try-row">
        <span className={`docs-method m-get`}>GET</span>
        <input
          className="docs-try-input"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          spellCheck={false}
        />
        <button type="button" onClick={run} disabled={state.status === 'loading'}>
          {state.status === 'loading' ? 'Running…' : 'Run'}
        </button>
      </div>

      {state.status === 'error' && <p className="error">{state.message}</p>}
      {state.status === 'ok' && (
        <>
          <div className="docs-block-head">
            <span className="subtle">Live response</span>
            <CopyButton text={JSON.stringify(state.json, null, 2)} />
          </div>
          <pre className="docs-code docs-live">{JSON.stringify(state.json, null, 2)}</pre>
        </>
      )}
    </div>
  );
}

function ArgTable({ title, rows, noType }) {
  return (
    <div className="docs-block">
      <div className="docs-block-head">
        <strong>{title}</strong>
      </div>
      <table className="docs-table">
        <tbody>
          {rows.map(([name, type, desc]) => (
            <tr key={name}>
              <td className="docs-arg">{name}</td>
              {!noType && <td className="docs-type">{type}</td>}
              <td colSpan={noType ? 2 : 1}>{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
