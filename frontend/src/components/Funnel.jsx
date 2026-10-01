import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { formatCount } from '../adStats';

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
    { label: 'Won', cell: (c) => num(c.won) },
    { label: 'Won %', cell: (c) => pct(c.won, c.mql), pct: true },
    { label: 'Revenue', cell: (c) => money(c.revenue) },
    { label: 'Lost', cell: (c) => num(c.lost) },
  ],
};

function Cells({ c, cols, bold }) {
  const style = bold ? { fontWeight: 600 } : undefined;
  return cols.map((col, i) => {
    const className = [i === 0 && 'funnel-mh', col.pct && 'funnel-pct'].filter(Boolean).join(' ') || undefined;
    if (!c || !c.mql) return <td key={col.label} className={className}>{col.pct ? null : dot}</td>;
    return (
      <td key={col.label} className={className} style={col.pct ? undefined : style}>
        {col.cell(c)}
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
function FunnelTable({ rows, labelKey, labelHead, months, asOf, cols, withReasons, footer }) {
  return (
    <div className="card funnel-scroll" style={{ padding: 0 }}>
      <table className="tasks funnel-table">
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
                <Cells key={m} c={r.byMonth[m]} cols={cols} />
              ))}
              <Cells c={r.total} cols={cols} bold />
              {withReasons && <Reasons list={r.topLostReasons} />}
            </tr>
          ))}
        </tbody>
        {footer && (
          <tfoot>
            <tr style={{ fontWeight: 700 }}>
              <td className="funnel-src">{footer.label}</td>
              {months.map((m) => (
                <Cells key={m} c={footer.byMonth[m]} cols={cols} bold />
              ))}
              <Cells c={footer.total} cols={cols} bold />
              {withReasons && <Reasons list={footer.topLostReasons} />}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

export default function Funnel({ isAdmin }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [view, setView] = useState('funnel');

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
      <p className="subtle" style={{ marginTop: 0 }}>
        <b>MQL</b> = Bigin contacts created that month. <b>SQL</b> = those MQLs with at least one call
        longer than 30 seconds in that same month. SQL % = SQL ÷ MQL. <b>Late</b> = not SQL, but called
        over 30 seconds in a later month. <b>Won</b> / <b>Lost</b> = the contact's deals at any time
        (a contact with any won deal is never lost); revenue is the won deals' amount. Deals count against
        the month the contact was created, so recent months keep growing.
      </p>

      <div className="summary-grid">
        {months.map((m) => {
          const c = res.byMonth[m];
          return (
            <div key={m} className="card">
              <div className="label">{monthLabel(m, asOf)}</div>
              <div className="num">
                {formatCount(c.mql)} <span className="subtle funnel-unit">MQL</span>
              </div>
              <div className="subtle">
                {formatCount(c.sql)} SQL · <b>{pct(c.sql, c.mql) || '—'}</b>
                {c.lateSql ? ` · ${formatCount(c.lateSql)} late` : ''}
              </div>
              <div className="subtle">
                {formatCount(c.won)} won · <b>{pct(c.won, c.mql) || '—'}</b> · {c.revenue ? RUPEES.format(c.revenue) : '₹0'}
                {' · '}
                {formatCount(c.lost)} lost
              </div>
              <div className="funnel-bar">
                <div className="funnel-bar-sql" style={{ width: `${c.mql ? (c.sql / c.mql) * 100 : 0}%` }} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="filters">
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
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      <h3 style={{ margin: '18px 0 8px' }}>Lead source × month</h3>
      <FunnelTable
        rows={res?.sources || []}
        labelKey="source"
        labelHead="Lead source"
        months={months}
        asOf={asOf}
        cols={cols}
        withReasons={withReasons}
        footer={footer && { ...footer, label: 'All sources' }}
      />
      {res && !res.sources.length && (
        <p className="subtle">No contacts yet — run the contact backfill, or wait for the Bigin contact webhook.</p>
      )}
      {!res && !error && <p className="subtle">Loading…</p>}

      {isAdmin && res?.owners?.length > 0 && (
        <>
          <h3 style={{ margin: '18px 0 8px' }}>Owner × month</h3>
          <FunnelTable
            rows={res.owners}
            labelKey="owner"
            labelHead="Owner"
            months={months}
            asOf={asOf}
            cols={cols}
            withReasons={withReasons}
            footer={footer && { ...footer, label: 'All owners' }}
          />
        </>
      )}
    </>
  );
}
