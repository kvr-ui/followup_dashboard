import { useEffect, useMemo, useRef, useState } from 'react';
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

// Bigin's Up_Scale values are long and repeat the stage:
//   "Inter G1 - Closed with Sale - (Upsell - Inter G2)"
// The only part a manager needs on a crowded row is what they were upsold TO.
function upsellLabel(v) {
  const m = String(v).match(/\(\s*Upsell\s*-?\s*(.+?)\s*\)/i);
  return m ? `upsold to ${m[1]}` : String(v);
}

function statusBadge(s) {
  if (s === 'done') return <span className="badge badge-low">transcribed</span>;
  if (s === 'pending') return <span className="badge status-in-progress">pending</span>;
  if (s === 'failed') return <span className="badge badge-high">failed</span>;
  return <span className="badge status-not-started">{s}</span>;
}

export default function Calls() {
  const [stats, setStats] = useState(null);
  const [outcomes, setOutcomes] = useState(null); // won/lost + why we lose
  const [journeys, setJourneys] = useState([]);
  const [coverage, setCoverage] = useState({ withCalls: 0, withoutCalls: 0, count: 0 });
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [owner, setOwner] = useState('');
  // The two tabs ARE the outcome. Won and lost are different questions — "what
  // did a winning journey look like" vs "why did we lose" — so they get separate
  // pages rather than one mixed list.
  const [outcome, setOutcome] = useState('won');
  const [reason, setReason] = useState('');       // filter by why it was lost
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');           // deal closed between…
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('');       // transcription state
  const [minDuration, setMinDuration] = useState('');
  const [minCalls, setMinCalls] = useState('');
  const [hasCalls, setHasCalls] = useState('');   // '' = all closed leads
  const [upsold, setUpsold] = useState('');       // won tab only: '' | yes | no
  const [open, setOpen] = useState({});      // expanded journeys
  const [selected, setSelected] = useState(null); // call id for the drawer
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Everything the journeys query filters on. Typed fields (search, amounts) are
  // NOT in here — they apply on Enter/Apply, so we don't refetch on every keypress.
  const auto = [owner, outcome, reason, from, to, status, minDuration, minCalls, hasCalls, upsold];

  // `outcome` is the tab, not a filter — it's always set, so counting it would
  // show "Clear (1)" on a page with nothing filtered, and clearing it would
  // leave the tab bar pointing at nothing.
  const activeCount = [
    owner, reason, search, from, to, status, minDuration, minCalls, hasCalls, upsold,
  ].filter(Boolean).length;

  function clearAll() {
    setOwner(''); setReason(''); setSearch('');
    setFrom(''); setTo('');
    setStatus(''); setMinDuration(''); setMinCalls(''); setHasCalls(''); setUpsold('');
    setPage(1);
  }

  async function load() {
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams();
      if (owner) qs.set('owner', owner);
      if (outcome) qs.set('outcome', outcome);
      if (reason) qs.set('reason', reason);
      if (search) qs.set('search', search);
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      if (status) qs.set('status', status);
      if (minDuration) qs.set('minDuration', minDuration);
      if (minCalls) qs.set('minCalls', minCalls);
      if (hasCalls) qs.set('hasCalls', hasCalls);
      if (upsold) qs.set('upsold', upsold);
      qs.set('page', String(page));

      const [s, o, j] = await Promise.all([
        api('/api/calls/stats'),
        api(`/api/calls/outcomes${owner ? `?owner=${encodeURIComponent(owner)}` : ''}`),
        api(`/api/calls/journeys?${qs.toString()}`),
      ]);
      setStats(s);
      setOutcomes(o);
      setJourneys(j.data || []);
      setCoverage({
        withCalls: j.withCalls ?? 0,
        withoutCalls: j.withoutCalls ?? 0,
        count: j.count ?? 0,
      });
      setPages(j.pages ?? 1);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  // Refetch when a filter or the page changes — but when a FILTER changes, snap
  // back to page 1 first. Otherwise you'd sit on page 5 of a result set that now
  // only has 2 pages and see an empty list.
  const sig = JSON.stringify(auto);
  const lastSig = useRef(sig);

  useEffect(() => {
    if (lastSig.current !== sig) {
      lastSig.current = sig;
      if (page !== 1) {
        setPage(1); // this re-runs the effect with page=1; don't also fetch now
        return;
      }
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, page]);

  // Owners come from the outcome stats, not the journeys on screen — otherwise
  // filtering to one salesperson would empty the dropdown you filtered with.
  const owners = useMemo(
    () => (outcomes?.byOwner || []).filter((o) => o.ownerEmail),
    [outcomes]
  );

  const totals = useMemo(() => {
    const calls = journeys.reduce((a, j) => a + j.totalCalls, 0);
    const mins = Math.round(journeys.reduce((a, j) => a + j.totalDuration, 0) / 60);
    const done = journeys.reduce((a, j) => a + j.transcribed, 0);
    return { calls, mins, done };
  }, [journeys]);

  // Deals whose loss reason nobody filled in are counted, but can't be filtered
  // on — so keep them out of the dropdown while still showing them in the list.
  const reasonList = useMemo(
    () => (outcomes?.reasons || []).filter((r) => r.reason),
    [outcomes]
  );
  const noReasonCount = useMemo(
    () => (outcomes?.reasons || []).find((r) => !r.reason)?.count ?? 0,
    [outcomes]
  );

  const isWon = outcome === 'won';

  // Switching tab is a different question, so drop the filters that only make
  // sense on the other one and go back to page 1.
  function switchTab(next) {
    if (next === outcome) return;
    setOutcome(next);
    setReason('');   // lost-only
    setUpsold('');   // won-only
    setPage(1);
  }

  return (
    <>
      <div className="tabs" style={{ width: 'fit-content', marginBottom: 16 }}>
        <button
          onClick={() => switchTab('won')}
          className={isWon ? 'tab active' : 'tab'}
        >
          Closed with Sale ({outcomes?.won ?? '—'})
        </button>
        <button
          onClick={() => switchTab('lost')}
          className={!isWon ? 'tab active' : 'tab'}
        >
          Closed without Sale ({outcomes?.lost ?? '—'})
        </button>
      </div>

      <div className="summary-grid">
        <div className="card">
          <div
            className="num"
            style={{ color: isWon ? 'var(--green)' : 'var(--red, #c0392b)' }}
          >
            {coverage.count}
          </div>
          <div className="label">{isWon ? 'Won' : 'Lost'}</div>
        </div>
        <div className="card">
          <div className="num">{coverage.withCalls}</div>
          <div className="label">…with a recorded call</div>
        </div>
        <div className="card">
          <div className="num" style={{ opacity: 0.6 }}>{coverage.withoutCalls}</div>
          <div className="label">…with no call</div>
        </div>
        {isWon ? (
          <div
            className="card"
            // Click to see exactly who was upsold. Without this you'd be scanning
            // four pages of won deals hunting for a badge.
            onClick={() => setUpsold(upsold === 'yes' ? '' : 'yes')}
            style={{
              cursor: 'pointer',
              outline: upsold === 'yes' ? '2px solid var(--green, #27ae60)' : 'none',
            }}
            title={upsold === 'yes' ? 'Showing upsold leads — click to clear' : 'Click to see who was upsold'}
          >
            {/* Counted server-side across ALL won deals — the journeys list is
                paginated, so counting the visible page would under-report. */}
            <div className="num" style={{ color: 'var(--green)' }}>
              {outcomes?.upsold ?? '—'}
            </div>
            <div className="label">Upsold {upsold === 'yes' ? '(filtered)' : ''}</div>
          </div>
        ) : (
          <div className="card week">
            <div className="num">{outcomes ? `${outcomes.winRate}%` : '—'}</div>
            <div className="label">Win rate (overall)</div>
          </div>
        )}
        <div className="card">
          <div className="num">{totals.mins}</div>
          <div className="label">Minutes of audio</div>
        </div>
        <div className="card">
          <div className="num" style={{ color: 'var(--green)' }}>{totals.done}</div>
          <div className="label">Transcribed</div>
        </div>
      </div>

      {/* Only the lost tab has a "why". */}
      {!isWon && reasonList.length > 0 && (
        <div className="card" style={{ padding: '14px 16px', marginBottom: 16 }}>
          <div className="label" style={{ marginBottom: 10 }}>Why deals are lost</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {reasonList.map((r) => (
              <button
                key={r.reason}
                onClick={() => {
                  setOutcome('lost');
                  setReason(reason === r.reason ? '' : r.reason);
                }}
                className={`badge ${reason === r.reason ? 'badge-high' : 'badge-normal'}`}
                style={{ cursor: 'pointer', border: 'none' }}
                title="Click to filter"
              >
                {r.reason} · {r.count}
              </button>
            ))}
            {noReasonCount > 0 && (
              <span className="badge status-not-started" title="Lost, but nobody recorded why">
                no reason given · {noReasonCount}
              </span>
            )}
          </div>
        </div>
      )}

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
        {/* The tabs are the outcome now — no dropdown. "Lost because" only
            exists on the lost tab; a won deal has no loss reason. */}
        {!isWon && (
          <label>
            Lost because
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">Any reason</option>
              {reasonList.map((r) => (
                <option key={r.reason} value={r.reason}>
                  {r.reason} ({r.count})
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Salesperson
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">All</option>
            {owners.map((o) => (
              <option key={o.ownerEmail} value={o.ownerEmail}>
                {o.ownerName || o.ownerEmail} ({o.won}W / {o.lost}L)
              </option>
            ))}
          </select>
        </label>

        <label>
          Closed from
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          Closed to
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>

        {/* Upsell only exists on won deals — Bigin's Up_Scale is literally
            "... Closed with Sale - (Upsell - ...)". Meaningless on the lost tab. */}
        {isWon && (
          <label>
            Upsell
            <select value={upsold} onChange={(e) => setUpsold(e.target.value)}>
              <option value="">All won leads</option>
              <option value="yes">Upsold only</option>
              <option value="no">Not upsold</option>
            </select>
          </label>
        )}

        <label>
          Calls
          <select value={hasCalls} onChange={(e) => setHasCalls(e.target.value)}>
            <option value="">All closed leads</option>
            <option value="yes">Has a recorded call</option>
            <option value="no">No call recorded</option>
          </select>
        </label>

        <label>
          Transcript
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any</option>
            <option value="transcribed">Has a transcript</option>
            <option value="pending">Waiting to transcribe</option>
            <option value="none">Not transcribed</option>
          </select>
        </label>

        <label>
          Min call length
          <select value={minDuration} onChange={(e) => setMinDuration(e.target.value)}>
            <option value="">Any</option>
            <option value="30">30s+</option>
            <option value="60">1 min+</option>
            <option value="180">3 min+</option>
            <option value="300">5 min+</option>
          </select>
        </label>

        <label>
          Min calls
          <select value={minCalls} onChange={(e) => setMinCalls(e.target.value)}>
            <option value="">Any</option>
            <option value="2">2+</option>
            <option value="3">3+</option>
            <option value="5">5+</option>
          </select>
        </label>

        <button onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Apply'}
        </button>
        {activeCount > 0 && (
          <button onClick={clearAll} disabled={loading}>
            Clear ({activeCount})
          </button>
        )}
      </div>

      {error && <div className="error">{error}</div>}

      <p id="status">
        {coverage.count} lead{coverage.count === 1 ? '' : 's'}{' '}
        {isWon ? 'closed with sale' : 'closed without sale'} —{' '}
        <strong>{coverage.withCalls}</strong> with recorded calls,{' '}
        <strong>{coverage.withoutCalls}</strong> with none.
        {isWon && outcomes?.upsold != null && (
          <>
            {' '}
            <strong style={{ color: 'var(--green, #27ae60)' }}>{outcomes.upsold}</strong>{' '}
            upsold.
          </>
        )}
        {pages > 1 && ` Showing ${journeys.length} (page ${page} of ${pages}).`}
      </p>

      {/* Column headings for the journey rows. Without these the Upsell column is
          just an unexplained badge floating in the middle of the row. */}
      {isWon && journeys.length > 0 && (
        <div
          className="subtle"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '0 14px 6px',
            fontSize: '0.72rem',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          <span>Lead</span>
          <span style={{ display: 'flex', gap: 12 }}>
            <span style={{ flex: '0 0 150px' }}>Upsell</span>
            <span>Calls · Duration · Dates · Owner · Score</span>
          </span>
        </div>
      )}

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
                  <span className="chev" style={{ opacity: j.totalCalls ? 1 : 0.2 }}>
                    {isOpen ? '▾' : '▸'}
                  </span>
                  <div>
                    <div className="who">{j.contactName || j.phone || j.deal?.name}</div>
                    <div className="subtle">
                      {j.phone} · {j.deal?.name}
                      {j.outcome === 'lost' && (
                        <>
                          {' · '}
                          {j.lostReason ? (
                            <em>{j.lostReason}</em>
                          ) : (
                            <em style={{ opacity: 0.6 }}>no reason given</em>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="journey-meta">
                  {/* No won/lost badge — the tab already says which you're on. */}

                  {/* UPSELL — a real column on the won tab, not a badge that only
                      appears sometimes. It renders on EVERY won row, blank when the
                      rep didn't upsell, so "nobody is upselling" is as visible as
                      "someone did". A badge that only shows on a hit would hide the
                      more important fact: how rarely this happens. */}
                  {isWon && (
                    <span
                      style={{ flex: '0 0 150px', textAlign: 'left' }}
                      title={j.deal?.upScale || 'No upsell recorded in Bigin'}
                    >
                      {j.deal?.upScale ? (
                        <span
                          className="badge"
                          style={{ background: 'var(--green, #27ae60)', color: '#fff' }}
                        >
                          ⬆ {upsellLabel(j.deal.upScale).replace(/^upsold to /, '')}
                        </span>
                      ) : (
                        <span className="subtle">—</span>
                      )}
                    </span>
                  )}

                  {j.totalCalls > 0 ? (
                    <>
                      <span className="badge badge-normal">{j.totalCalls} calls</span>
                      <span className="subtle">{mmss(j.totalDuration)}</span>
                      <span className="subtle">
                        {shortDate(j.firstCall)} → {shortDate(j.lastCall)}
                      </span>
                    </>
                  ) : (
                    // Closed without a single recorded call — WhatsApp, personal
                    // phone, or walk-in. Nothing to grade, but you should see it.
                    <span className="badge status-not-started">no call recorded</span>
                  )}
                  <span className="badge badge-low">{j.deal?.ownerName}</span>
                  {j.avgScore != null ? (
                    <span className="score-pill">{Math.round(j.avgScore)}</span>
                  ) : (
                    <span className="subtle">not graded</span>
                  )}
                </div>
              </div>

              {isOpen && j.totalCalls > 0 && (
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
          <p className="subtle">No closed leads match these filters.</p>
        )}
      </div>

      {pages > 1 && (
        <div className="filters" style={{ justifyContent: 'center', marginTop: 16 }}>
          <button onClick={() => setPage(1)} disabled={page === 1 || loading}>
            « First
          </button>
          <button onClick={() => setPage((p) => p - 1)} disabled={page === 1 || loading}>
            ‹ Prev
          </button>
          <span className="subtle" style={{ alignSelf: 'center' }}>
            Page {page} of {pages}
          </span>
          <button onClick={() => setPage((p) => p + 1)} disabled={page >= pages || loading}>
            Next ›
          </button>
          <button onClick={() => setPage(pages)} disabled={page >= pages || loading}>
            Last »
          </button>
        </div>
      )}

      {selected && <CallDetail callId={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
