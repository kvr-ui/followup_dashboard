import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import DateRangeBar from './DateRangeBar';
import PageHeader from './ui/PageHeader';
import Section from './ui/Section';
import DataTable from './ui/DataTable';
import StatCard, { StatGrid } from './ui/StatCard';
import EmptyState from './ui/EmptyState';
import Icon from './ui/Icon';
import {
  RESOLVED_BY,
  defaultRange,
  formatCount,
  formatDay,
  formatPaise,
  formatPct,
  formatRupees,
  relativeTime,
  rollUp,
  sortRows,
  utmBreakdown,
} from '../adStats';

// The Marketing tab — what the retired CRM's dashboard showed, rebuilt on the
// admin ads API. Spend, campaign performance, where the leads came from,
// whether Meta's own totals agree with ours, and the sync controls.
//
// NO CHART. On purpose: the frontend depends on React and nothing else, and a
// spend time-series adds no fact the campaign table does not already carry.
//
// EVERY FIGURE COMES FROM THE SERVER'S OWN ROLL-UP
// ------------------------------------------------
// The KPI row renders /api/ads/summary verbatim and the campaign table renders
// /api/ads/campaigns verbatim — this file recomputes neither. That is what makes
// the tab reconcile with Meta: the backend's totals were verified against the
// Graph API's account-level figures, so anything recomputed here could only
// disagree with them. The one client-side sum is the table's totals footer,
// which uses the shared `rollUp` and must equal the KPI row.

// Sortable numeric columns of the campaign table. `render` decides the
// formatter, and that choice is the whole rupees/paise story: `spend`, `cpc`
// and `cpl` are rupees; `dailyBudget` is paise and gets the other formatter.
const COLUMNS = [
  { key: 'dailyBudget', label: 'Budget / day', render: (r) => formatPaise(r.dailyBudget) },
  { key: 'spend', label: 'Spend', render: (r) => formatRupees(r.spend) },
  { key: 'impressions', label: 'Impr.', render: (r) => formatCount(r.impressions) },
  { key: 'clicks', label: 'Clicks', render: (r) => formatCount(r.clicks) },
  { key: 'ctr', label: 'CTR', render: (r) => formatPct(r.ctr) },
  { key: 'cpc', label: 'CPC', render: (r) => formatRupees(r.cpc) },
  { key: 'leads', label: 'Leads', render: (r) => formatCount(r.leads) },
  { key: 'cpl', label: 'CPL', render: (r) => formatRupees(r.cpl) },
];

const STATUS_CLASS = {
  success: 'badge badge-low',
  error: 'badge badge-high',
  running: 'badge badge-normal',
};

const q = (range) => `from=${range.from}&to=${range.to}`;

export default function Marketing() {
  const [range, setRange] = useState(defaultRange);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [sortKey, setSortKey] = useState('spend');
  const [sortDir, setSortDir] = useState('desc');

  const [history, setHistory] = useState(null);
  const [syncMsg, setSyncMsg] = useState('');
  const [syncErr, setSyncErr] = useState('');
  const [syncBusy, setSyncBusy] = useState(false);

  const load = useCallback(async (r) => {
    setLoading(true);
    try {
      const [summary, campaigns, reconciliation, leads] = await Promise.all([
        api(`/api/ads/summary?${q(r)}`),
        api(`/api/ads/campaigns?${q(r)}`),
        api(`/api/ads/reconciliation?${q(r)}`),
        // Leads only feed the UTM breakdown here; 1000 is the endpoint's cap.
        api(`/api/ads/leads?${q(r)}&limit=1000`),
      ]);
      setData({
        summary: summary.data,
        campaigns: campaigns.data || [],
        reconciliation: reconciliation.data,
        leads: leads.data || [],
        leadTotals: leads.totals,
        leadsTruncated: leads.truncated,
      });
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await api('/api/ads/sync/history?limit=12'));
    } catch {
      // The sync panel failing must not blank out the numbers above it.
      setHistory(null);
    }
  }, []);

  useEffect(() => {
    load(range);
  }, [load, range]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // While a sync is in flight, poll the audit trail; when it stops running,
  // reload the figures once — a finished sync has just rewritten them.
  const wasRunning = useRef(false);
  useEffect(() => {
    const running = Boolean(history && history.running);
    if (running) {
      wasRunning.current = true;
      const timer = setInterval(loadHistory, 5000);
      return () => clearInterval(timer);
    }
    if (wasRunning.current) {
      wasRunning.current = false;
      setSyncBusy(false);
      setSyncMsg('Sync finished. Figures reloaded.');
      load(range);
    }
    return undefined;
  }, [history, loadHistory, load, range]);

  async function syncNow() {
    setSyncBusy(true);
    setSyncErr('');
    setSyncMsg('');
    try {
      const res = await api('/api/ads/sync', {
        method: 'POST',
        body: { from: range.from, to: range.to },
      });
      setSyncMsg(res.message || 'Sync started.');
      // 202 means STARTED, not finished — the history poll above takes over.
      await loadHistory();
    } catch (err) {
      setSyncErr(err.message);
      setSyncBusy(false);
    }
  }

  function toggleSort(key) {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  const campaignRows = useMemo(
    () => sortRows(data ? data.campaigns : [], sortKey, sortDir),
    [data, sortKey, sortDir]
  );
  const campaignTotals = useMemo(() => rollUp(data ? data.campaigns : []), [data]);
  const breakdown = useMemo(
    () => utmBreakdown(data ? data.leads : [], data ? data.campaigns : []),
    [data]
  );

  const s = data && data.summary;
  const rec = data && data.reconciliation;
  const runs = (history && history.data) || [];
  const lastRun = runs[0];
  const running = Boolean(history && history.running);

  const arrow = (key) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <>
      <PageHeader
        actions={
          <DateRangeBar range={range} onChange={setRange}>
            <button onClick={() => load(range)} disabled={loading}>
              <Icon name="refresh" size={14} />
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </DateRangeBar>
        }
      />

      {error && <div className="error">{error}</div>}
      {!data && !error && <p className="subtle">Loading marketing data…</p>}

      {data && (
        <>
          <div className="mkt-kpis">
            <StatGrid>
              <StatCard label="Spend" value={formatRupees(s.spend)} />
              <StatCard label="Leads" value={formatCount(s.leads)} />
              <StatCard label="Cost per lead" value={formatRupees(s.cpl)} />
              <StatCard label="Click-through rate" value={formatPct(s.ctr)} />
              <StatCard label="Impressions" value={formatCount(s.impressions)} />
              <StatCard label="Clicks" value={formatCount(s.clicks)} />
            </StatGrid>
          </div>

          <p className="subtle mkt-note mkt-lead-note">
            {formatDay(range.from)} – {formatDay(range.to)} · {formatCount(s.insightRows)}{' '}
            campaign-level insight row(s). Leads are Meta&apos;s own <code>lead</code> result,
            which is already deduplicated across form and pixel.
          </p>

          {/* ---------------- Campaign performance ---------------- */}
          <Section
            title="Campaign performance"
            meta={`${campaignRows.length} campaign(s) with spend in range`}
            flush={campaignRows.length > 0}
          >
            {campaignRows.length === 0 ? (
              <EmptyState title="No campaign spend in this range">
                Try a wider window, or sync.
              </EmptyState>
            ) : (
              <DataTable className="mkt-wide">
                <thead>
                  <tr>
                    <th
                      className="mkt-sortable"
                      onClick={() => toggleSort('name')}
                      title="Sort by campaign name"
                    >
                      Campaign{arrow('name')}
                    </th>
                    <th>Status</th>
                    {COLUMNS.map((c) => (
                      <th
                        key={c.key}
                        className="mkt-sortable num"
                        onClick={() => toggleSort(c.key)}
                        title={`Sort by ${c.label}`}
                      >
                        {c.label}
                        {arrow(c.key)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {campaignRows.map((r) => (
                    <tr key={r.campaignId}>
                      <td>
                        <div className="who">{r.name || r.campaignId}</div>
                        <div className="subtle">
                          {r.known ? r.objective || '—' : 'not in the mirror — archived at Meta'}
                        </div>
                      </td>
                      <td>
                        <span className="badge badge-normal">
                          {r.effectiveStatus || r.status || '—'}
                        </span>
                      </td>
                      {COLUMNS.map((c) => (
                        <td key={c.key} className="num">
                          {c.render(r)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2}>
                      <b>All campaigns</b>
                    </td>
                    {COLUMNS.map((c) => (
                      <td key={c.key} className="num">
                        {/* Budgets do not add up to anything meaningful across
                            campaigns on different schedules, so the footer
                            leaves that column blank rather than inventing a sum. */}
                        {c.key === 'dailyBudget' ? '' : c.render(campaignTotals)}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </DataTable>
            )}
            <p className="subtle mkt-note">
              Spend, CPC and CPL are rupees; Budget / day is Meta&apos;s paise figure converted for
              display. CTR, CPC and CPL are recomputed from the totals, never averaged.
            </p>
          </Section>

          {/* ---------------- UTM breakdown ---------------- */}
          <Section
            title="Where the leads came from"
            meta={`${formatCount(breakdown.total)} lead(s) captured in range${
              data.leadsTruncated ? ' (list capped at 1,000)' : ''
            }`}
          >
            {breakdown.total === 0 ? (
              <EmptyState title="No leads captured in this range" />
            ) : (
              <div className="mkt-split">
                <div>
                  <h4 className="mkt-subhead">By source / medium</h4>
                  <DataTable>
                    <thead>
                      <tr>
                        <th>Source / medium</th>
                        <th className="num">Leads</th>
                      </tr>
                    </thead>
                    <tbody>
                      {breakdown.bySource.map((r) => (
                        <tr key={r.label}>
                          <td>{r.label}</td>
                          <td className="num">{formatCount(r.leads)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </DataTable>
                </div>

                <div>
                  <h4 className="mkt-subhead">By campaign · spend and cost per captured lead</h4>
                  <DataTable>
                    <thead>
                      <tr>
                        <th>Campaign</th>
                        <th className="num">Leads</th>
                        <th className="num">Spend</th>
                        <th className="num">CPL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {breakdown.byCampaign.map((r) => (
                        <tr key={r.key}>
                          <td>
                            {r.name}
                            {/* Only a row that HAS a campaign needs to say how it
                                got one — the two bucket rows already name their
                                own state, and tagging them repeats it. */}
                            {(r.campaignId ? r.resolvedBy : []).map((how) => (
                              <span key={how} className="mkt-how" title={RESOLVED_BY[how]?.hint}>
                                {RESOLVED_BY[how]?.label || how}
                              </span>
                            ))}
                          </td>
                          <td className="num">{formatCount(r.leads)}</td>
                          <td className="num">{formatRupees(r.spend)}</td>
                          <td className="num">{formatRupees(r.cpl)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </DataTable>
                  <p className="subtle mkt-note">
                    This CPL is campaign spend over the leads WE captured, which is a different
                    question from the campaign table&apos;s CPL of spend over Meta&apos;s reported
                    lead results. Rows tagged <b>alias</b> were mapped to a campaign by an admin,
                    not by Meta&apos;s own data.
                  </p>
                </div>
              </div>
            )}
          </Section>

          {/* ---------------- Reconciliation ---------------- */}
          <Section
            title="Spend reconciliation"
            meta={`${formatCount(rec.accountRows)} account row(s) · ${formatCount(
              rec.campaignRows
            )} campaign row(s)`}
          >
            {!rec.comparable ? (
              <p className="hint">
                No account-level rows in this range, so there is nothing to compare against. Run a
                sync to pull Meta&apos;s own account total.
              </p>
            ) : (
              <dl className="mkt-recon">
                <div>
                  <dt>Meta account total</dt>
                  <dd>
                    <b>{formatRupees(rec.accountSpend)}</b>
                  </dd>
                </div>
                <div>
                  <dt>Sum of campaigns</dt>
                  <dd>{formatRupees(rec.campaignSpend)}</dd>
                </div>
                <div className={rec.difference === 0 ? '' : 'mkt-recon-gap'}>
                  <dt>Difference</dt>
                  <dd>
                    {rec.difference > 0 ? '+' : ''}
                    {formatRupees(rec.difference)}
                  </dd>
                </div>
              </dl>
            )}

            <p className="subtle mkt-note">
              Small gaps are normal — Meta&apos;s figures settle for ~24–48 hours, and spend not
              tied to a campaign only shows in the account total. A large or growing gap usually
              means a sync did not finish.
            </p>
          </Section>

          {/* ---------------- Sync ---------------- */}
          <Section
            title="Sync"
            actions={
              <button onClick={syncNow} disabled={syncBusy || running}>
                <Icon name="refresh" size={14} />
                {running ? 'Syncing…' : syncBusy ? 'Starting…' : 'Sync now'}
              </button>
            }
          >
            {history && !history.configured && (
              <p className="hint">
                Meta is not configured on the server (META_ACCESS_TOKEN / META_AD_ACCOUNT_ID), so
                &ldquo;Sync now&rdquo; will be refused.
              </p>
            )}
            {syncErr && <div className="error">{syncErr}</div>}
            {syncMsg && <div className="notice">{syncMsg}</div>}

            {lastRun && (
              <p className="subtle mkt-note mkt-last-run">
                Last run {relativeTime(lastRun.finishedAt || lastRun.startedAt)} · {lastRun.resource}{' '}
                · <span className={STATUS_CLASS[lastRun.status] || 'badge badge-normal'}>
                  {lastRun.status}
                </span>
              </p>
            )}

            {runs.length === 0 ? (
              <EmptyState title="No sync runs recorded yet" />
            ) : (
              <DataTable>
                <thead>
                  <tr>
                    <th>Resource</th>
                    <th>Status</th>
                    <th className="num">Records</th>
                    <th>Started</th>
                    <th>Finished</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td>{r.resource}</td>
                      <td>
                        <span className={STATUS_CLASS[r.status] || 'badge badge-normal'}>
                          {r.status}
                        </span>
                        {r.error && <div className="subtle">{r.error}</div>}
                      </td>
                      <td className="num">{formatCount(r.recordsUpserted)}</td>
                      <td className="subtle">{new Date(r.startedAt).toLocaleString()}</td>
                      <td className="subtle">
                        {r.finishedAt ? new Date(r.finishedAt).toLocaleString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
          </Section>
        </>
      )}
    </>
  );
}
