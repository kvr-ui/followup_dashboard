import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import CallDetail from './CallDetail';

/**
 * The sales scorecard — AI call grades turned into something a manager coaches from.
 *
 * Deliberately answers three questions, in order of usefulness:
 *   1. Which rep needs help?      → per-rep averages
 *   2. What skill is the gap?     → weakest criteria across the team
 *   3. Where does it break?       → first-call vs follow-up, and the worst calls to review
 *
 * "Not gradeable" calls (wrong number, call-me-back) are excluded from every average
 * server-side — scoring a dead call as 0 and blaming the rep for it is the fastest way
 * to make a scorecard nobody trusts.
 */
const prettyCriterion = (k) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Green ≥75, amber 50–74, red below. One scale for the whole page. */
function color(pct) {
  if (pct >= 75) return 'var(--green, #4d7a63)';
  if (pct >= 50) return 'var(--amber, #b8860b)';
  return 'var(--red, #c0392b)';
}

const PERIODS = [
  ['all', 'All time'],
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
];

const prettyDay = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - date) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};

export default function Scorecard({ user } = {}) {
  const isAdmin = user?.role === 'admin';
  const [res, setRes] = useState(null);
  const [owner, setOwner] = useState('');
  const [period, setPeriod] = useState('all');
  const [outcome, setOutcome] = useState(''); // '' = all calls
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const q = new URLSearchParams();
      if (owner) q.set('owner', owner);
      if (period !== 'all') q.set('period', period);
      if (outcome) q.set('outcome', outcome);
      const qs = q.toString();
      setRes(await api(`/api/calls/grades${qs ? `?${qs}` : ''}`));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [owner, period, outcome]);

  useEffect(() => {
    load();
  }, [load]);

  const reps = useMemo(() => res?.perRep || [], [res]);

  if (!res && !error) return <p className="subtle">Loading scorecard…</p>;

  const o = res?.overall || {};
  const cov = res?.coverage || {};
  const recentDays = res?.recentDays || [];

  return (
    <>
      {/* Period selector — the old (all-time) data stays; this re-cuts it by date. */}
      <div className="quick-tabs" style={{ marginBottom: 14 }}>
        {PERIODS.map(([key, label]) => (
          <button
            key={key}
            className={period === key ? 'quick-tab active' : 'quick-tab'}
            onClick={() => setPeriod(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="summary-grid">
        <div className="card">
          <div className="num" style={{ color: color(o.avg) }}>{o.avg ?? '—'}</div>
          <div className="label">Team average</div>
        </div>
        <div className="card">
          <div className="num" style={{ color: 'var(--green, #4d7a63)' }}>
            {o.bands?.best || 0}
          </div>
          <div className="label">Best calls (90+)</div>
        </div>
        <div className="card">
          <div className="num" style={{ color: 'var(--red, #c0392b)' }}>{o.bands?.weak ?? 0}</div>
          <div className="label">Weak calls (&lt;50)</div>
        </div>
        <div className="card">
          <div className="num">{o.gradeable ?? 0}</div>
          <div className="label">Calls scored</div>
        </div>
        <div className="card">
          <div className="num">{cov.pct ?? 0}%</div>
          <div className="label">{cov.graded}/{cov.eligible} won calls graded</div>
        </div>
      </div>

      {!isAdmin && (
        <h2 style={{ margin: '4px 0 10px' }}>
          My performance{user?.name ? ` — ${user.name}` : ''}
        </h2>
      )}

      <div className="filters">
        {/* The team dropdown is an admin tool — a rep only ever sees their own numbers
            (the server scopes it), so showing a one-option picker would just confuse. */}
        {isAdmin && (
          <label>
            Salesperson
            <select value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">Whole team</option>
              {reps.map((r) => (
                <option key={r.ownerEmail} value={r.ownerEmail}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Calls
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="">All calls</option>
            <option value="won">Won only</option>
            <option value="lost">Lost only</option>
            <option value="open">Open only</option>
          </select>
        </label>
        <button onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {cov.pct < 100 && (
        <div className="hint">
          {cov.graded} of {cov.eligible} won calls are graded ({cov.pct}%). The {cov.eligible - cov.graded}{' '}
          ungraded calls aren't in these numbers yet — averages may shift once they're graded.
        </div>
      )}

      {/* --- Day by day (last 14 days), independent of the period filter --- */}
      <div className="card" style={{ padding: '16px 18px', marginTop: 12 }}>
        <h2 style={{ marginTop: 0 }}>Day by day</h2>
        {recentDays.length === 0 ? (
          <p className="subtle">No graded calls in the last 14 days.</p>
        ) : (
          <table className="tasks">
            <thead>
              <tr>
                <th>Day</th>
                <th style={{ textAlign: 'right' }}>Calls</th>
                <th style={{ textAlign: 'right' }}>Avg score</th>
                <th style={{ textAlign: 'right' }}>Best (90+)</th>
              </tr>
            </thead>
            <tbody>
              {recentDays.map((d) => (
                <tr key={d.date}>
                  <td className="contact-name">{prettyDay(d.date)}</td>
                  <td style={{ textAlign: 'right' }}>{d.calls}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: color(d.avg) }}>{d.avg}</td>
                  <td style={{ textAlign: 'right', color: d.best ? 'var(--green, #4d7a63)' : 'var(--muted)' }}>{d.best}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="subtle" style={{ marginTop: 8 }}>
          Every won call graded in the last 14 days, by the day the call happened. New calls
          appear here once they're transcribed and graded.
        </div>
      </div>

      {o.gradeable === 0 && period !== 'all' && (
        <div className="hint">
          No graded calls in this period yet. Either no won calls happened, or they haven't been
          graded. Switch to "All time" to see the full history.
        </div>
      )}

      {/* --- Per rep --- */}
      <div className="card" style={{ padding: '16px 18px', marginTop: 12 }}>
        <h2 style={{ marginTop: 0 }}>By salesperson</h2>
        <table className="tasks">
          <thead>
            <tr>
              <th>Salesperson</th>
              <th style={{ textAlign: 'right' }}>Total calls</th>
              <th style={{ textAlign: 'right' }}>Graded</th>
              <th style={{ textAlign: 'right' }}>Avg score</th>
              <th style={{ textAlign: 'right', color: 'var(--green, #4d7a63)' }}>Best (90+)</th>
              <th style={{ textAlign: 'right' }}>Good (70–89)</th>
              <th style={{ textAlign: 'right', color: 'var(--amber, #b8860b)' }}>OK (50–69)</th>
              <th style={{ textAlign: 'right', color: 'var(--red, #c0392b)' }}>Weak (&lt;50)</th>
              <th>Spread</th>
            </tr>
          </thead>
          <tbody>
            {reps.map((r) => {
              const best = r.bands.best || 0;
              const good = r.bands.good || 0;
              const ok = r.bands.ok || 0;
              const weak = r.bands.weak || 0;
              return (
                <tr key={r.ownerEmail}>
                  <td className="contact-name">{r.name}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{r.totalCalls ?? r.calls}</td>
                  <td style={{ textAlign: 'right', color: r.calls ? 'inherit' : 'var(--muted)' }}>{r.calls}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: color(r.avg) }}>{r.calls ? r.avg : '—'}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: best ? 'var(--green, #4d7a63)' : 'var(--muted)' }}>{best}</td>
                  <td style={{ textAlign: 'right', color: good ? 'inherit' : 'var(--muted)' }}>{good}</td>
                  <td style={{ textAlign: 'right', color: ok ? 'var(--amber, #b8860b)' : 'var(--muted)' }}>{ok}</td>
                  <td style={{ textAlign: 'right', fontWeight: weak ? 600 : 400, color: weak ? 'var(--red, #c0392b)' : 'var(--muted)' }}>{weak}</td>
                  <td style={{ minWidth: 140 }}>
                    <BandBar bands={r.bands} total={r.calls} />
                  </td>
                </tr>
              );
            })}
            {reps.length === 0 && (
              <tr>
                <td colSpan={9} className="subtle">No graded calls yet.</td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="subtle" style={{ marginTop: 8 }}>
          Total calls = every call the rep made in the period. Graded = the ≥30s recorded calls
          that were transcribed and scored (the four band columns add up to this). Best = 90+ (a
          call worth showing a new joiner). "Avg score" is the mean out of 100 across that rep's
          graded calls. Dead calls (wrong number, call-me-back) are excluded — they measure luck,
          not skill.
        </div>
      </div>

      {/* --- Weakest skills --- */}
      <div className="card" style={{ padding: '16px 18px', marginTop: 12 }}>
        <h2 style={{ marginTop: 0 }}>Where the team is weakest</h2>
        <div className="subtle" style={{ marginBottom: 12 }}>
          Every criterion scored as a % of its maximum, across all graded calls. The ones at the
          top are where coaching moves the needle most.
        </div>
        {(res.byCriterion || []).map((c) => (
          <div key={c.criterion} style={{ marginBottom: 8 }}>
            <div className="row-between" style={{ marginBottom: 2 }}>
              <span>{prettyCriterion(c.criterion)}</span>
              <span className="rate-num" style={{ color: color(c.pct) }}>{c.pct}%</span>
            </div>
            <div className="rate-wrap">
              <div className="rate-bar">
                <span style={{ width: `${c.pct}%`, background: color(c.pct) }} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* --- By call type --- */}
      <div className="card" style={{ padding: '16px 18px', marginTop: 12 }}>
        <h2 style={{ marginTop: 0 }}>By call type</h2>
        <div className="mini-grid">
          {(res.byCallType || []).map((t) => (
            <div className="panel-sm" key={t.type}>
              <h3>{prettyCriterion(t.type)}</h3>
              <div className="num" style={{ fontSize: '1.5rem', color: t.type === 'not_gradeable' ? 'var(--muted)' : color(t.avg) }}>
                {t.type === 'not_gradeable' ? '—' : t.avg}
              </div>
              <div className="subtle">{t.calls} call{t.calls === 1 ? '' : 's'}</div>
            </div>
          ))}
        </div>
        <div className="subtle" style={{ marginTop: 8 }}>
          Usually first-calls score lowest and closings highest — a low first-call number means the
          gap is in how reps open and qualify, not how they close.
        </div>
      </div>

      {/* --- Best / worst calls to review --- */}
      <div className="mini-grid" style={{ marginTop: 12 }}>
        <div className="card" style={{ padding: '16px 18px' }}>
          <h2 style={{ marginTop: 0 }}>Show these to new joiners</h2>
          <CallList calls={res.topCalls} onOpen={setSelected} />
        </div>
        <div className="card" style={{ padding: '16px 18px' }}>
          <h2 style={{ marginTop: 0 }}>Coach these</h2>
          <CallList calls={res.bottomCalls} onOpen={setSelected} />
        </div>
      </div>

      {selected && <CallDetail callId={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

/** A stacked bar of the four score bands, for a rep's row. */
function BandBar({ bands, total }) {
  if (!total) return <span className="subtle">—</span>;
  const seg = [
    ['best', 'var(--green, #4d7a63)'],
    ['good', '#6b9b83'],
    ['ok', 'var(--amber, #b8860b)'],
    ['weak', 'var(--red, #c0392b)'],
  ];
  return (
    <div style={{ display: 'flex', height: 14, borderRadius: 4, overflow: 'hidden', background: 'var(--surface-inset)' }}>
      {seg.map(([k, c]) =>
        bands[k] ? (
          <div
            key={k}
            title={`${k}: ${bands[k]}`}
            style={{ width: `${(bands[k] / total) * 100}%`, background: c }}
          />
        ) : null
      )}
    </div>
  );
}

function CallList({ calls, onOpen }) {
  if (!calls || calls.length === 0) return <p className="subtle">Nothing here yet.</p>;
  return (
    <div>
      {calls.map((c) => (
        <div
          key={c.id}
          className="clickable-row"
          onClick={() => onOpen(c.id)}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 10,
            padding: '8px 0',
            borderBottom: '1px solid var(--border)',
            cursor: 'pointer',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div className="contact-name">{c.lead}</div>
            <div className="subtle" style={{ fontSize: '0.78rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {c.rep} · {prettyCriterion(c.callType || '')} · {c.minutes}m
            </div>
          </div>
          <span className="score-pill" style={{ background: color(c.score), color: '#fff', alignSelf: 'center' }}>
            {c.score}
          </span>
        </div>
      ))}
    </div>
  );
}
