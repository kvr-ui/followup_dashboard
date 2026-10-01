import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import CallDetail from './CallDetail';
import PageHeader from './ui/PageHeader';
import FilterBar from './ui/FilterBar';
import DataTable from './ui/DataTable';
import Section from './ui/Section';
import SubTabs from './ui/SubTabs';
import EmptyState from './ui/EmptyState';
import StatCard, { StatGrid } from './ui/StatCard';
import Icon from './ui/Icon';
import '../styles/views/reports.css';

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
function tone(pct) {
  if (pct >= 75) return 'green';
  if (pct >= 50) return 'amber';
  return 'red';
}

const PERIODS = [
  { id: 'all', label: 'All time' },
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
];
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

  // The "calls" column counts calls made within the selected period, so name it after
  // that period — "Today lead calls" on the Today view, "Total lead calls" on All time.
  const CALLS_COL = {
    all: 'Total lead calls',
    today: 'Today lead calls',
    yesterday: 'Yesterday lead calls',
    '7d': 'Last 7d lead calls',
    '30d': 'Last 30d lead calls',
  };
  const callsColLabel = CALLS_COL[period] || 'Total lead calls';

  if (!res && !error) return <p className="subtle">Loading scorecard…</p>;

  const o = res?.overall || {};
  const cov = res?.coverage || {};

  return (
    <div className="report scorecard">
      {/* Period selector — the old (all-time) data stays; this re-cuts it by date. */}
      <SubTabs tabs={PERIODS} active={period} onSelect={setPeriod} />

      <StatGrid>
        <StatCard label="Team average" value={o.avg ?? '—'} tone={tone(o.avg)} />
        <StatCard label="Best calls (90+)" value={o.bands?.best || 0} tone="green" />
        <StatCard label="Weak calls (<50)" value={o.bands?.weak ?? 0} tone="red" />
        <StatCard label="Calls scored" value={o.gradeable ?? 0} />
        {/* "gradeable", not "won": the default view is every call, and the denominator
            is calls that HAVE audio — rang-but-never-answered rows are shown apart. */}
        <StatCard
          label={`${cov.graded}/${cov.eligible} gradeable calls graded`}
          value={`${cov.pct ?? 0}%`}
        />
      </StatGrid>

      {!isAdmin && <PageHeader title={`My performance${user?.name ? ` — ${user.name}` : ''}`} />}

      <FilterBar>
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
          <Icon name="refresh" size={14} />
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </FilterBar>

      {error && <div className="error">{error}</div>}

      {cov.pct < 100 && (
        <div className="hint">
          {cov.graded} of {cov.eligible} gradeable calls are graded ({cov.pct}%). The{' '}
          {cov.eligible - cov.graded} ungraded calls aren't in these numbers yet — averages
          may shift once they're graded.
        </div>
      )}

      {/* Without this the day reads as a failure: a fully-graded day still shows a big
          gap between calls dialled and calls scored, purely because most attempts rang
          out. Naming them stops that gap looking like a broken pipeline. */}
      {cov.noAudio > 0 && (
        <div className="hint">
          {cov.noAudio} of {cov.dialled} call attempts were never answered (no recording),
          so they can't be transcribed or scored. Coverage above counts only calls that
          actually connected.
        </div>
      )}

      {o.gradeable === 0 && period !== 'all' && (
        <div className="hint">
          No graded calls in this period yet. Either no won calls happened, or they haven't been
          graded. Switch to "All time" to see the full history.
        </div>
      )}

      {/* --- Per rep --- */}
      <Section title="By salesperson" flush>
        {reps.length > 0 ? (
          <DataTable>
            <thead>
              <tr>
                <th>Salesperson</th>
                <th className="num">{callsColLabel}</th>
                {/* Dialled vs connected sit side by side so the drop between "calls made"
                    and "calls graded" is visibly explained by unanswered rings. */}
                <th className="num">Connected</th>
                <th className="num">Graded</th>
                <th className="num">Avg score</th>
                <th className="num txt-green">Best (90+)</th>
                <th className="num">Good (70–89)</th>
                <th className="num txt-amber">OK (50–69)</th>
                <th className="num txt-red">Weak (&lt;50)</th>
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
                    <td className="num txt-semi">{r.totalCalls ?? r.calls}</td>
                    <td className={r.connectedCalls ? 'num' : 'num txt-muted'}>
                      {r.connectedCalls ?? '—'}
                    </td>
                    <td className={r.calls ? 'num' : 'num txt-muted'}>{r.calls}</td>
                    <td className={`num txt-bold txt-${tone(r.avg)}`}>{r.calls ? r.avg : '—'}</td>
                    <td className={`num txt-bold ${best ? 'txt-green' : 'txt-muted'}`}>{best}</td>
                    <td className={good ? 'num' : 'num txt-muted'}>{good}</td>
                    <td className={`num ${ok ? 'txt-amber' : 'txt-muted'}`}>{ok}</td>
                    <td className={`num ${weak ? 'txt-semi txt-red' : 'txt-muted'}`}>{weak}</td>
                    <td className="sc-spread">
                      <BandBar bands={r.bands} total={r.calls} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        ) : (
          <div className="sc-pad">
            <EmptyState title="No graded calls yet" />
          </div>
        )}
        <p className="subtle sc-footnote">
          Total calls = every call the rep made in the period. Graded = the ≥30s recorded calls
          that were transcribed and scored (the four band columns add up to this). Best = 90+ (a
          call worth showing a new joiner). "Avg score" is the mean out of 100 across that rep's
          graded calls. Dead calls (wrong number, call-me-back) are excluded — they measure luck,
          not skill.
        </p>
      </Section>

      {/* --- Weakest skills --- */}
      <Section
        title="Where the team is weakest"
        meta="Every criterion scored as a % of its maximum, across all graded calls. The ones at the top are where coaching moves the needle most."
      >
        {(res.byCriterion || []).map((c) => (
          <div key={c.criterion} className="sc-crit">
            <div className="row-between sc-crit-head">
              <span>{prettyCriterion(c.criterion)}</span>
              <span className={`rate-num txt-${tone(c.pct)}`}>{c.pct}%</span>
            </div>
            <div className="rate-wrap">
              <div className="rate-bar">
                <span className={`fill-${tone(c.pct)}`} style={{ width: `${c.pct}%` }} />
              </div>
            </div>
          </div>
        ))}
      </Section>

      {/* --- By call type --- */}
      <Section title="By call type">
        <StatGrid>
          {(res.byCallType || []).map((t) => (
            <StatCard
              key={t.type}
              label={prettyCriterion(t.type)}
              value={t.type === 'not_gradeable' ? '—' : t.avg}
              tone={t.type === 'not_gradeable' ? undefined : tone(t.avg)}
              hint={`${t.calls} call${t.calls === 1 ? '' : 's'}`}
            />
          ))}
        </StatGrid>
        <p className="subtle">
          Usually first-calls score lowest and closings highest — a low first-call number means the
          gap is in how reps open and qualify, not how they close.
        </p>
      </Section>

      {/* --- Best / worst calls to review --- */}
      <div className="sc-pair">
        <Section title="Show these to new joiners">
          <CallList calls={res.topCalls} onOpen={setSelected} />
        </Section>
        <Section title="Coach these">
          <CallList calls={res.bottomCalls} onOpen={setSelected} />
        </Section>
      </div>

      {selected && <CallDetail callId={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

const BANDS = ['best', 'good', 'ok', 'weak'];

/** A stacked bar of the four score bands, for a rep's row. */
function BandBar({ bands, total }) {
  if (!total) return <span className="subtle">—</span>;
  return (
    <div className="band-bar">
      {BANDS.map((k) =>
        bands[k] ? (
          <div
            key={k}
            className={`band-${k}`}
            title={`${k}: ${bands[k]}`}
            style={{ width: `${(bands[k] / total) * 100}%` }}
          />
        ) : null
      )}
    </div>
  );
}

function CallList({ calls, onOpen }) {
  if (!calls || calls.length === 0) return <EmptyState title="Nothing here yet" />;
  return (
    <div>
      {calls.map((c) => (
        <div key={c.id} className="clickable-row sc-call" onClick={() => onOpen(c.id)}>
          <div className="sc-call-main">
            <div className="contact-name">{c.lead}</div>
            <div className="subtle sc-call-meta">
              {c.rep} · {prettyCriterion(c.callType || '')} · {c.minutes}m
            </div>
          </div>
          <span className={`score-pill pill-${tone(c.score)}`}>{c.score}</span>
        </div>
      ))}
    </div>
  );
}
