import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import CopyButton from './CopyButton';
import PageHeader from './ui/PageHeader';
import FilterBar from './ui/FilterBar';
import DataTable from './ui/DataTable';
import StatCard, { StatGrid } from './ui/StatCard';
import EmptyState from './ui/EmptyState';
import Icon from './ui/Icon';
import { openLead } from '../route';
import { LEAD_STATES, LEAD_STATUS, formatCount, formatDay, relativeTime } from '../adStats';
import { parseDueDate, startOfToday } from '../taskStats';
import { statusClass } from '../utils';
import '../styles/views/deals.css';

// The Leads tab — every person the dashboard knows about, one row each, whatever
// tab they first turned up in. A click opens the full lead page.
//
// Admins see everyone. A rep sees their own leads plus the ones nobody owns yet;
// the server pins that scope (GET /api/leads-list), this component only asks.
// Filtering, sorting and paging are server-side, so the list stays light however
// many leads there are.

const PAGE_SIZE = 50;

// Funnel stage — derived server-side (leadState.funnelStage).
const STAGE = {
  mql: { label: 'MQL', hint: 'Marketing qualified — a form fill, ad lead or task, no call over 30s yet' },
  sql: { label: 'SQL', hint: 'Sales qualified — a call over 30s, or a deal in Bigin' },
  closed: { label: 'Closed', hint: 'Closed with sale' },
};
const STAGES = Object.keys(STAGE);

const EMPTY_FILTERS = {
  q: '',
  status: '',
  stage: '',
  source: '',
  owner: '', // email, or '__unassigned'
  from: '',
  to: '',
  sort: 'lastActivity',
};

function FollowUp({ value }) {
  const due = parseDueDate(value);
  if (!due) return <span className="subtle">—</span>;
  const overdue = due < startOfToday();
  return (
    <span className={overdue ? 'deals-overdue' : undefined}>
      {formatDay(value)}
      {overdue && <div className="subtle">overdue</div>}
    </span>
  );
}

export default function Leads({ isAdmin }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  // The search box is debounced into `filters.q`, so typing doesn't fire a
  // request per keystroke.
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => (f.q === search ? f : { ...f, q: search }));
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const set = (key) => (e) => {
    setFilters((f) => ({ ...f, [key]: e.target.value }));
    setPage(1);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      for (const [k, v] of Object.entries(filters)) {
        if (!v) continue;
        if (k === 'owner' && v === '__unassigned') params.set('unassigned', '1');
        else params.set(k, v);
      }
      setRes(await api(`/api/leads-list?${params}`));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = res?.rows || [];
  const facets = res?.facets;
  const total = res?.total ?? 0;
  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);

  // A summary card doubles as a status filter; clicking the active one clears it.
  const focusState = (state) => {
    setFilters((f) => ({ ...f, status: f.status === state ? '' : state }));
    setPage(1);
  };

  const focusStage = (stage) => {
    setFilters((f) => ({ ...f, stage: f.stage === stage ? '' : stage }));
    setPage(1);
  };

  return (
    <>
      <StatGrid>
        <StatCard
          label={isAdmin ? 'All leads' : 'Your leads + unassigned'}
          value={facets ? formatCount(facets.total) : '—'}
          onClick={() => focusState('')}
        />
        {LEAD_STATES.map((s) => (
          <StatCard
            key={s}
            label={LEAD_STATUS[s].label}
            value={facets ? formatCount(facets.byState[s]) : '—'}
            title={LEAD_STATUS[s].hint}
            active={filters.status === s}
            onClick={() => focusState(s)}
          />
        ))}
      </StatGrid>

      <StatGrid>
        {STAGES.map((s) => (
          <StatCard
            key={s}
            label={STAGE[s].label}
            value={facets?.byStage ? formatCount(facets.byStage[s]) : '—'}
            title={STAGE[s].hint}
            active={filters.stage === s}
            onClick={() => focusStage(s)}
          />
        ))}
      </StatGrid>

      <FilterBar>
        <label>
          Search
          <input
            type="text"
            placeholder="Name or phone"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label>
          Status
          <select value={filters.status} onChange={set('status')}>
            <option value="">All</option>
            {LEAD_STATES.map((s) => (
              <option key={s} value={s}>
                {LEAD_STATUS[s].label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Stage
          <select value={filters.stage} onChange={set('stage')}>
            <option value="">All</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE[s].label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Source
          <select value={filters.source} onChange={set('source')}>
            <option value="">All</option>
            {(facets?.sources || []).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Owner
          <select value={filters.owner} onChange={set('owner')}>
            <option value="">All</option>
            <option value="__unassigned">Unassigned ({facets?.unassigned ?? 0})</option>
            {isAdmin &&
              (facets?.owners || []).map((o) => (
                <option key={o.email} value={o.email}>
                  {o.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Created from
          <input type="date" value={filters.from} onChange={set('from')} />
        </label>
        <label>
          to
          <input type="date" value={filters.to} onChange={set('to')} />
        </label>
        <label>
          Sort
          <select value={filters.sort} onChange={set('sort')}>
            <option value="lastActivity">Last activity</option>
            <option value="created">Newest created</option>
            <option value="nextFollowUp">Next follow-up</option>
            <option value="name">Name</option>
          </select>
        </label>
        <button
          onClick={() => {
            setSearch('');
            setFilters(EMPTY_FILTERS);
            setPage(1);
          }}
        >
          Clear
        </button>
      </FilterBar>

      {error && <div className="error">{error}</div>}

      <PageHeader
        meta={
          <span id="status">
            {res ? `${formatCount(total)} lead${total === 1 ? '' : 's'} match` : 'Loading…'}
            {total > PAGE_SIZE && ` — page ${page} of ${pages}`}
          </span>
        }
        actions={
          <button onClick={load} disabled={loading}>
            <Icon name="refresh" size={14} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        }
      />

      {res && !rows.length ? (
        <EmptyState title="No leads match the current filters" />
      ) : (
        <DataTable>
          <thead>
            <tr>
              <th>Lead</th>
              <th>Phone</th>
              <th>Status</th>
              <th>Stage</th>
              <th>Owner</th>
              <th>Source</th>
              <th>Next follow-up</th>
              <th>Created</th>
              <th>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.phoneKey} className="clickable-row" onClick={() => openLead(r.phoneKey)}>
                <td className="deals-lead">
                  <a
                    href={`#/lead/${r.phoneKey}`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      openLead(r.phoneKey);
                    }}
                  >
                    {r.name || '—'}
                  </a>
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <span className="deals-phone">
                    {r.phone || r.phoneKey}
                    <CopyButton text={r.phone || r.phoneKey} />
                  </span>
                </td>
                <td>
                  <span className={statusClass(r.state)} title={LEAD_STATUS[r.state]?.hint}>
                    {LEAD_STATUS[r.state]?.label || r.state}
                  </span>
                </td>
                <td>
                  {STAGE[r.stage] ? (
                    <span className={`badge stage-${r.stage}`} title={STAGE[r.stage].hint}>
                      {STAGE[r.stage].label}
                    </span>
                  ) : (
                    <span className="subtle">—</span>
                  )}
                </td>
                <td>
                  {r.unassigned ? (
                    <span className="badge badge-high">Unassigned</span>
                  ) : (
                    r.ownerName || r.ownerEmail || <span className="subtle">—</span>
                  )}
                </td>
                <td>
                  {r.source || <span className="subtle">—</span>}
                  {r.campaign && <div className="subtle">{r.campaign}</div>}
                </td>
                <td>
                  <FollowUp value={r.nextFollowUp} />
                </td>
                <td className="subtle">{formatDay(r.createdAt)}</td>
                <td className="subtle" title={r.lastActivity ? new Date(r.lastActivity).toLocaleString('en-IN') : ''}>
                  {r.lastActivity ? relativeTime(r.lastActivity) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {pages > 1 && (
        <div className="deals-pager">
          <button onClick={() => setPage((p) => p - 1)} disabled={page <= 1 || loading}>
            ← Prev
          </button>
          <span className="subtle">
            Page {page} of {pages}
          </span>
          <button onClick={() => setPage((p) => p + 1)} disabled={page >= pages || loading}>
            Next →
          </button>
        </div>
      )}
    </>
  );
}
