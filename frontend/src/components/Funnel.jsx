import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { formatCount } from '../adStats';

// The Funnel tab — MQL vs SQL by lead source and month, the same numbers as the
// Bigin MQL/SQL report.
//
//   MQL  a Bigin contact, in the IST month it was created
//   SQL  an MQL with a call over 30s in that same month
//
// Definitions and scope live on the server (backend/modules/leads/services/
// funnel.js); this component only lays the counts out.

const EMPTY_FILTERS = { months: '3', owner: '' };

const MONTH_LABEL = new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });

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

function Cells({ c, bold }) {
  const style = bold ? { fontWeight: 600 } : undefined;
  if (!c || !c.mql) {
    return (
      <>
        <td className="funnel-mh">{dot}</td>
        <td>{dot}</td>
        <td />
      </>
    );
  }
  return (
    <>
      <td className="funnel-mh" style={style}>
        {formatCount(c.mql)}
      </td>
      <td style={style}>{num(c.sql)}</td>
      <td className="funnel-pct">{pct(c.sql, c.mql)}</td>
    </>
  );
}

export default function Funnel({ isAdmin }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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

  return (
    <>
      <p className="subtle" style={{ marginTop: 0 }}>
        <b>MQL</b> = Bigin contacts created that month. <b>SQL</b> = those MQLs with at least one call
        longer than 30 seconds in that same month. SQL % = SQL ÷ MQL.
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
                {' · '}
                {formatCount(c.closed)} closed
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
        <button onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      <h3 style={{ margin: '18px 0 8px' }}>Lead source × month</h3>
      <div className="card funnel-scroll" style={{ padding: 0 }}>
        <table className="tasks funnel-table">
          <thead>
            <tr>
              <th />
              {months.map((m) => (
                <th key={m} colSpan={3} className="funnel-mh funnel-center">
                  {monthLabel(m, asOf)}
                </th>
              ))}
              <th colSpan={3} className="funnel-mh funnel-center">
                Total
              </th>
            </tr>
            <tr>
              <th className="funnel-src">Lead source</th>
              {[...months, 'total'].map((m) => (
                <Fragment key={m}>
                  <th className="funnel-mh">MQL</th>
                  <th>SQL</th>
                  <th>SQL %</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {(res?.sources || []).map((s) => (
              <tr key={s.source}>
                <td className="funnel-src">{s.source}</td>
                {months.map((m) => (
                  <Cells key={m} c={s.byMonth[m]} />
                ))}
                <Cells c={s.total} bold />
              </tr>
            ))}
          </tbody>
          {res && (
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td className="funnel-src">All sources</td>
                {months.map((m) => (
                  <Cells key={m} c={res.byMonth[m]} bold />
                ))}
                <Cells c={res.total} bold />
              </tr>
            </tfoot>
          )}
        </table>
        {res && !res.sources.length && (
          <p className="subtle" style={{ padding: '0 16px' }}>
            No contacts yet — run the contact backfill, or wait for the Bigin contact webhook.
          </p>
        )}
        {!res && !error && <p className="subtle" style={{ padding: '0 16px' }}>Loading…</p>}
      </div>
    </>
  );
}
