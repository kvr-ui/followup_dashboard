import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { formatCount } from '../adStats';
import LeadLink from './LeadLink';
import FilterBar from './ui/FilterBar';
import DataTable from './ui/DataTable';
import Section from './ui/Section';
import StatCard, { StatGrid } from './ui/StatCard';
import EmptyState from './ui/EmptyState';
import Icon from './ui/Icon';

// The Funnel tab — MQL vs SQL by lead source and month, the same numbers as the
// Bigin MQL/SQL report, plus what those leads became.
//
//   MQL       a Bigin contact, in the IST month it was created
//   SQL       an MQL with a call over 30s in that same month
//   Late SQL  not SQL, but such a call in a later month
//   Won/Lost  the contact's deals, at any time, credited to its created month
//
// Definitions and scope live on the server (backend/modules/leads/services/
// funnel.js); this component only lays the counts out.

const EMPTY_FILTERS = { months: '3', owner: '' };

const MONTH_LABEL = new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });

// Deal amounts are whole rupees; paise would only add noise across a table.
const RUPEES = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const CREATED = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

/** 'Sep 2026', or 'Sep 2026 (1–25)' for the month still running. */
function monthLabel(key, asOf) {
  const [y, m] = key.split('-').map(Number);
  const label = MONTH_LABEL.format(new Date(Date.UTC(y, m - 1, 1)));
  if (!asOf) return label;
  const ist = new Date(new Date(asOf).getTime() + 330 * 60000);
  const current = ist.toISOString().slice(0, 7) === key;
  return current ? `${label} (1–${ist.getUTCDate()})` : label;
}

function pct(part, whole) {
  return whole ? `${((part / whole) * 100).toFixed(1)}%` : '';
}

const dot = <span className="subtle">·</span>;
const num = (n) => (n ? formatCount(n) : dot);
const money = (n) => (n ? RUPEES.format(n) : dot);

// The two column sets a month group can show. Each column reads one count
// bucket; `pct` columns are styled as the accent percentage.
const VIEWS = {
  funnel: [
    { label: 'MQL', cell: (c) => formatCount(c.mql) },
    { label: 'SQL', cell: (c) => num(c.sql) },
    { label: 'SQL %', cell: (c) => pct(c.sql, c.mql), pct: true },
    { label: 'Late', cell: (c) => num(c.lateSql), title: 'Not SQL, but called over 30s in a later month' },
  ],
  outcome: [
    { label: 'MQL', cell: (c) => formatCount(c.mql) },
    { label: 'Won', cell: (c, ctx) => <WonCount n={c.won} onOpen={ctx && ctx.onWon} /> },
    { label: 'Won %', cell: (c) => pct(c.won, c.mql), pct: true },
    { label: 'Revenue', cell: (c) => money(c.revenue) },
    { label: 'Lost', cell: (c) => num(c.lost) },
    {
      label: 'Junk',
      cell: (c) => num(c.junk),
      title: 'Lost as WrongNumber / Not Enq, Wrong Course/Level or Language Issue',
    },
    { label: 'Junk %', cell: (c) => pct(c.junk, c.mql), pct: true },
  ],
};

/** A won count with a small list button that opens the leads behind it. */
function WonCount({ n, onOpen }) {
  if (!n) return dot;
  return (
    <span className="funnel-won">
      {formatCount(n)}
      {onOpen && (
        <button type="button" className="funnel-won-btn" title="Show the won leads" onClick={onOpen}>
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M2 4h12M2 8h12M2 12h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </span>
  );
}

function Cells({ c, cols, bold, ctx }) {
  return cols.map((col, i) => {
    const className = [i === 0 && 'funnel-mh', col.pct && 'funnel-pct'].filter(Boolean).join(' ') || undefined;
    if (!c || !c.mql) return <td key={col.label} className={className}>{col.pct ? null : dot}</td>;
    const boldClass = bold && !col.pct ? 'funnel-bold' : '';
    return (
      <td key={col.label} className={[className, boldClass].filter(Boolean).join(' ') || undefined}>
        {col.cell(c, ctx)}
      </td>
    );
  });
}

function Reasons({ list }) {
  if (!list || !list.length) return <td className="funnel-reasons">{dot}</td>;
  return (
    <td className="funnel-reasons">
      {list.map((r) => `${r.reason} (${formatCount(r.count)})`).join(', ')}
    </td>
  );
}

/** One row per source or owner, a column group per month, then Total. */
function FunnelTable({ rows, labelKey, labelHead, months, asOf, cols, withReasons, footer, rowCell, onWon }) {
  const ctx = (cell, month) => ({ onWon: () => onWon({ ...cell, month }) });
  return (
    <DataTable className="funnel-table">
      <thead>
        <tr>
          <th />
          {[...months, 'total'].map((m) => (
            <th key={m} colSpan={cols.length} className="funnel-mh funnel-center">
              {m === 'total' ? 'Total' : monthLabel(m, asOf)}
            </th>
          ))}
          {withReasons && <th />}
        </tr>
        <tr>
          <th className="funnel-src">{labelHead}</th>
          {[...months, 'total'].map((m) => (
            <Fragment key={m}>
              {cols.map((col, i) => (
                <th key={col.label} className={i === 0 ? 'funnel-mh' : undefined} title={col.title}>
                  {col.label}
                </th>
              ))}
            </Fragment>
          ))}
          {withReasons && <th className="funnel-mh funnel-reasons">Top lost reasons</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.email || r[labelKey]}>
            <td className="funnel-src">{r[labelKey]}</td>
            {months.map((m) => (
              <Cells key={m} c={r.byMonth[m]} cols={cols} ctx={ctx(rowCell(r), m)} />
            ))}
            <Cells c={r.total} cols={cols} bold ctx={ctx(rowCell(r), '')} />
            {withReasons && <Reasons list={r.topLostReasons} />}
          </tr>
        ))}
      </tbody>
      {footer && (
        <tfoot>
          <tr className="funnel-foot">
            <td className="funnel-src">{footer.label}</td>
            {months.map((m) => (
              <Cells key={m} c={footer.byMonth[m]} cols={cols} bold ctx={ctx({}, m)} />
            ))}
            <Cells c={footer.total} cols={cols} bold ctx={ctx({}, '')} />
            {withReasons && <Reasons list={footer.topLostReasons} />}
          </tr>
        </tfoot>
      )}
    </DataTable>
  );
}

/** Side drawer listing the won leads behind one cell. */
function WonDrawer({ cell, filters, asOf, onClose }) {
  const [res, setRes] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (!v) continue;
      if (k === 'owner' && v === '__unassigned') params.set('unassigned', '1');
      else params.set(k, v);
    }
    if (cell.month) params.set('month', cell.month);
    if (cell.source) params.set('source', cell.source);
    if (cell.rowOwner) params.set('rowOwner', cell.rowOwner);
    api(`/api/leads-list/funnel/won?${params}`)
      .then(setRes)
      .catch((e) => setError(e.message));
  }, [cell, filters]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const title = [cell.label, cell.month ? monthLabel(cell.month, asOf) : 'All months'].filter(Boolean).join(' · ');

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>Won leads</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <p className="subtle funnel-drawer-meta">
          {title}
          {res && ` — ${formatCount(res.leads.length)} leads · ${RUPEES.format(res.revenue)}`}
        </p>
        {error && <div className="error">{error}</div>}
        {!res && !error && <p className="subtle">Loading…</p>}
        {res && !res.leads.length && <p className="subtle">No won leads here.</p>}
        {res?.leads.map((l, i) => (
          <section key={l.contactId} className="drawer-section funnel-won-lead">
            <div className="funnel-won-head">
              <b>
                {i + 1}. <LeadLink phoneKey={l.phoneKey}>{l.name || 'No name'}</LeadLink>
              </b>
              {l.phone ? <a href={`tel:${l.phone}`}>{l.phone}</a> : <span className="subtle">No phone</span>}
            </div>
            <div className="subtle">
              Created {CREATED.format(new Date(l.createdTime))} · {l.source}
              {l.ownerName ? ` · ${l.ownerName}` : ''}
            </div>
            {l.deals.map((d, j) => (
              <div key={j} className="subtle">
                {d.name || 'Deal'} · <b>{RUPEES.format(d.amount)}</b>
                {d.closingDate ? ` · closed ${d.closingDate}` : ''}
                {d.ownerName && d.ownerName !== l.ownerName ? ` · deal owner ${d.ownerName}` : ''}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

export default function Funnel({ isAdmin }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [view, setView] = useState('funnel');
  const [wonCell, setWonCell] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(filters)) {
        if (!v) continue;
        if (k === 'owner' && v === '__unassigned') params.set('unassigned', '1');
        else params.set(k, v);
      }
      setRes(await api(`/api/leads-list/funnel?${params}`));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  const set = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }));
  const months = res?.months || [];
  const asOf = res?.asOf;
  const cols = VIEWS[view];
  const withReasons = view === 'outcome';
  const footer = res && { byMonth: res.byMonth, total: res.total, topLostReasons: res.topLostReasons };

  return (
    <>
      <p className="subtle funnel-intro">
        <b>MQL</b> = Bigin contacts created that month. <b>SQL</b> = those MQLs with at least one call
        longer than 30 seconds in that same month. SQL % = SQL ÷ MQL. <b>Late</b> = not SQL, but called
        over 30 seconds in a later month. <b>Won</b> / <b>Lost</b> = the contact's deals at any time
        (a contact with any won deal is never lost); revenue is the won deals' amount. Deals count against
        the month the contact was created, so recent months keep growing.
      </p>

      <StatGrid>
        {months.map((m) => {
          const c = res.byMonth[m];
          return (
            <StatCard
              key={m}
              label={monthLabel(m, asOf)}
              value={
                <>
                  {formatCount(c.mql)} <span className="subtle funnel-unit">MQL</span>
                </>
              }
              hint={
                <>
                  <div className="subtle">
                    {formatCount(c.sql)} SQL · <b>{pct(c.sql, c.mql) || '—'}</b>
                    {c.lateSql ? ` · ${formatCount(c.lateSql)} late` : ''}
                  </div>
                  <div className="subtle">
                    <WonCount n={c.won} onOpen={() => setWonCell({ month: m })} /> won · <b>{pct(c.won, c.mql) || '—'}</b> · {c.revenue ? RUPEES.format(c.revenue) : '₹0'}
                    {' · '}
                    {formatCount(c.lost)} lost
                  </div>
                  <div className="funnel-bar">
                    <div className="funnel-bar-sql" style={{ width: `${c.mql ? (c.sql / c.mql) * 100 : 0}%` }} />
                  </div>
                </>
              }
            />
          );
        })}
      </StatGrid>

      <FilterBar>
        <label>
          Months
          <select value={filters.months} onChange={set('months')}>
            {(res?.monthChoices || [3, 4, 6, 12]).map((n) => (
              <option key={n} value={String(n)}>
                Last {n}
              </option>
            ))}
          </select>
        </label>
        {isAdmin && (
          <label>
            Owner
            <select value={filters.owner} onChange={set('owner')}>
              <option value="">All</option>
              <option value="__unassigned">Unassigned</option>
              {(res?.facets?.owners || []).map((o) => (
                <option key={o.email} value={o.email}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          View
          <select value={view} onChange={(e) => setView(e.target.value)}>
            <option value="funnel">Funnel (MQL → SQL)</option>
            <option value="outcome">Outcome (won / lost)</option>
          </select>
        </label>
        <button onClick={load} disabled={loading}>
          <Icon name="refresh" size={14} />
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </FilterBar>

      {error && <div className="error">{error}</div>}

      <Section title="Lead source × month" flush>
        <FunnelTable
          rows={res?.sources || []}
          labelKey="source"
          labelHead="Lead source"
          months={months}
          asOf={asOf}
          cols={cols}
          withReasons={withReasons}
          footer={footer && { ...footer, label: 'All sources' }}
          rowCell={(r) => ({ source: r.source, label: r.source })}
          onWon={setWonCell}
        />
      </Section>
      {res && !res.sources.length && (
        <EmptyState title="No contacts yet">
          Run the contact backfill, or wait for the Bigin contact webhook.
        </EmptyState>
      )}
      {!res && !error && <p className="subtle">Loading…</p>}

      {isAdmin && res?.owners?.length > 0 && (
        <Section title="Owner × month" flush>
          <FunnelTable
            rows={res.owners}
            labelKey="owner"
            labelHead="Owner"
            months={months}
            asOf={asOf}
            cols={cols}
            withReasons={withReasons}
            footer={footer && { ...footer, label: 'All owners' }}
            rowCell={(r) => ({ rowOwner: r.email || '__unassigned', label: r.owner })}
            onWon={setWonCell}
          />
        </Section>
      )}

      {wonCell && <WonDrawer cell={wonCell} filters={filters} asOf={asOf} onClose={() => setWonCell(null)} />}
    </>
  );
}
