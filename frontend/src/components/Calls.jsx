import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import CallDetail from './CallDetail';
import { formatDateTime } from '../utils';

function mmss(sec) {
  const s = Math.round(sec || 0);
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

function shortDate(d) {
  if (!d) return '—';
  const x = new Date(d);
  return x.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

function statusBadge(s) {
  if (s === 'done') return <span className="badge badge-low">transcribed</span>;
  if (s === 'pending') return <span className="badge status-in-progress">pending</span>;
  if (s === 'failed') return <span className="badge badge-high">failed</span>;
  return <span className="badge status-not-started">{s}</span>;
}

export default function Calls() {
  const [stats, setStats] = useState(null);
  const [journeys, setJourneys] = useState([]);
  const [owner, setOwner] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState({});      // expanded journeys
  const [selected, setSelected] = useState(null); // call id for the drawer
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams();
      if (owner) qs.set('owner', owner);
      if (search) qs.set('search', search);
      const [s, j] = await Promise.all([
        api('/api/calls/stats'),
        api(`/api/calls/journeys?${qs.toString()}`),
      ]);
      setStats(s);
      setJourneys(j.data || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);

  const owners = useMemo(() => {
    const set = new Map();
    journeys.forEach((j) => {
      if (j.deal?.ownerEmail) set.set(j.deal.ownerEmail, j.deal.ownerName || j.deal.ownerEmail);
    });
    return [...set.entries()];
  }, [journeys]);

  const totals = useMemo(() => {
    const calls = journeys.reduce((a, j) => a + j.totalCalls, 0);
    const mins = Math.round(journeys.reduce((a, j) => a + j.totalDuration, 0) / 60);
    const done = journeys.reduce((a, j) => a + j.transcribed, 0);
    return { calls, mins, done };
  }, [journeys]);

  return (
    <>
      <div className="summary-grid">
        <div className="card">
          <div className="num">{journeys.length}</div>
          <div className="label">Closed-sale journeys</div>
        </div>
        <div className="card">
          <div className="num">{totals.calls}</div>
          <div className="label">Calls in those journeys</div>
        </div>
        <div className="card week">
          <div className="num">{totals.mins}</div>
          <div className="label">Minutes of audio</div>
        </div>
        <div className="card">
          <div className="num" style={{ color: 'var(--green)' }}>
            {totals.done}
          </div>
          <div className="label">Transcribed</div>
        </div>
        <div className="card">
          <div className="num">{stats?.total ?? '—'}</div>
          <div className="label">Total calls synced</div>
        </div>
      </div>

      <div className="filters">
        <label>
          Search lead
          <input
            value={search}
            placeholder="name or phone…"
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
          />
        </label>
        <label>
          Salesperson
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">All</option>
            {owners.map(([email, name]) => (
              <option key={email} value={email}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <button onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Apply'}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      <p id="status">
        {journeys.length} closed-sale lead{journeys.length === 1 ? '' : 's'} — click a lead to see
        its call journey
      </p>

      <div className="journeys">
        {journeys.map((j) => {
          const isOpen = open[j._id];
          return (
            <div key={j._id} className={`journey ${isOpen ? 'open' : ''}`}>
              <div
                className="journey-head"
                onClick={() => setOpen((o) => ({ ...o, [j._id]: !o[j._id] }))}
              >
                <div className="journey-main">
                  <span className="chev">{isOpen ? '▾' : '▸'}</span>
                  <div>
                    <div className="who">{j.contactName || j.phone}</div>
                    <div className="subtle">
                      {j.phone} · {j.deal?.name}
                    </div>
                  </div>
                </div>

                <div className="journey-meta">
                  <span className="badge badge-normal">{j.totalCalls} calls</span>
                  <span className="subtle">{mmss(j.totalDuration)}</span>
                  <span className="subtle">
                    {shortDate(j.firstCall)} → {shortDate(j.lastCall)}
                  </span>
                  <span className="badge badge-low">{j.deal?.ownerName}</span>
                  {j.avgScore != null ? (
                    <span className="score-pill">{Math.round(j.avgScore)}</span>
                  ) : (
                    <span className="subtle">not graded</span>
                  )}
                </div>
              </div>

              {isOpen && (
                <ul className="call-list">
                  {j.calls.map((c, i) => (
                    <li key={c._id} onClick={() => setSelected(c._id)}>
                      <span className="call-n">#{i + 1}</span>
                      <span className="call-date">{formatDateTime(c.startedAt)}</span>
                      <span className="call-dur">{mmss(c.duration)}</span>
                      <span className="subtle">{c.direction}</span>
                      {statusBadge(c.transcriptionStatus)}
                      {c.score != null && <span className="score-pill">{c.score}</span>}
                      <span className="call-open">open →</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        {journeys.length === 0 && !loading && (
          <p className="subtle">No closed-sale journeys found.</p>
        )}
      </div>

      {selected && <CallDetail callId={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
