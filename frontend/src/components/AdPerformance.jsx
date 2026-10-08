import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import DateRangeBar from './DateRangeBar';
import PageHeader from './ui/PageHeader';
import Section from './ui/Section';
import DataTable from './ui/DataTable';
import StatCard, { StatGrid } from './ui/StatCard';
import EmptyState from './ui/EmptyState';
import Icon from './ui/Icon';
import {
  defaultRange,
  formatCount,
  formatDay,
  formatPct,
  formatRupees,
  performanceRates,
} from '../adStats';

// The Ad Performance tab — per campaign, ad set and ad: leads captured, and what
// became of them (junk, closed without a sale, closed with one, still open, no
// deal yet), against the spend. Renders GET /api/ads/performance verbatim; the
// only client-side maths is the per-row rates in adStats.performanceRates.
//
// The outcome columns do not overlap: Junk + Lost + Won + Pipeline + No deal =
// Leads. Junk is a closed-without-sale deal with a junk lost reason (the Funnel
// tab's rule) and is NOT counted again under Lost.

const COUNT_COLUMNS = [
  { key: 'leads', label: 'Leads' },
  { key: 'junk', label: 'Junk' },
  { key: 'junkPct', label: 'Junk %', rate: true },
  { key: 'lost', label: 'Lost', title: 'Closed without sale (excluding junk)' },
  { key: 'won', label: 'Won', title: 'Closed with sale' },
  { key: 'winPct', label: 'Win %', rate: true },
  { key: 'pipeline', label: 'Pipeline', title: 'Deal still open' },
  { key: 'noDeal', label: 'No deal', title: 'No Bigin deal found for this lead yet' },
];

const q = (range) => `from=${range.from}&to=${range.to}`;

function Cells({ counts, spend }) {
  const r = performanceRates(counts, spend);
  return (
    <>
      {COUNT_COLUMNS.map((c) => (
        <td key={c.key} className="num">
          {c.rate ? formatPct(r[c.key]) : formatCount(counts[c.key])}
        </td>
      ))}
      <td className="num">{formatRupees(spend)}</td>
      <td className="num">{formatRupees(r.cpl)}</td>
      <td className="num">{formatRupees(r.costPerSale)}</td>
      <td className="num">{formatRupees(counts.revenue)}</td>
      <td className="num">{r.roas == null ? '—' : `${r.roas.toFixed(2)}×`}</td>
    </>
  );
}

function Toggle({ open, onClick, label }) {
  return (
    <button
      type="button"
      className="adp-toggle"
      onClick={onClick}
      aria-expanded={open}
      aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
    >
      {open ? '▾' : '▸'}
    </button>
  );
}

const nameOr = (name, id, fallback) => name || (id && id !== 'unknown' ? id : fallback);

export default function AdPerformance() {
  const [range, setRange] = useState(defaultRange);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(() => new Set());

  const load = useCallback(async (r) => {
    setLoading(true);
    try {
      setData(await api(`/api/ads/performance?${q(r)}`));
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(range);
  }, [load, range]);

  const toggle = (key) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const totals = data && data.totals;
  const t = totals ? performanceRates(totals.counts, totals.spend) : null;
  const campaigns = (data && data.campaigns) || [];

  const rows = [];
  for (const c of campaigns) {
    const cKey = `c:${c.id}`;
    const cOpen = open.has(cKey);
    const expandable = c.adsets.length > 0 || c.landingPage;
    rows.push(
      <tr key={cKey} className="adp-campaign">
        <td>
          <div className="adp-name">
            {expandable ? (
              <Toggle open={cOpen} onClick={() => toggle(cKey)} label="campaign" />
            ) : (
              <span className="adp-toggle-spacer" />
            )}
            <span className="who">{nameOr(c.name, c.id, 'Unknown campaign')}</span>
          </div>
        </td>
        <Cells counts={c.counts} spend={c.spend} />
      </tr>
    );
    if (!cOpen) continue;

    for (const s of c.adsets) {
      const sKey = `s:${c.id}:${s.id}`;
      const sOpen = open.has(sKey);
      rows.push(
        <tr key={sKey} className="adp-adset">
          <td>
            <div className="adp-name adp-indent-1">
              <Toggle open={sOpen} onClick={() => toggle(sKey)} label="ad set" />
              <span>{nameOr(s.name, s.id, 'Unknown ad set')}</span>
            </div>
          </td>
          <Cells counts={s.counts} spend={s.spend} />
        </tr>
      );
      if (!sOpen) continue;
      for (const a of s.ads) {
        rows.push(
          <tr key={`a:${c.id}:${s.id}:${a.id}`} className="adp-ad">
            <td>
              <div className="adp-name adp-indent-2">
                <span className="adp-toggle-spacer" />
                <span>{nameOr(a.name, a.id, 'Unknown ad')}</span>
              </div>
            </td>
            <Cells counts={a.counts} spend={a.spend} />
          </tr>
        );
      }
    }

    if (c.landingPage) {
      rows.push(
        <tr key={`lp:${c.id}`} className="adp-adset">
          <td>
            <div className="adp-name adp-indent-1">
              <span className="adp-toggle-spacer" />
              <span className="subtle">Landing page (ad unknown)</span>
            </div>
          </td>
          <Cells counts={c.landingPage.counts} spend={null} />
        </tr>
      );
    }
  }

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
      {!data && !error && <p className="subtle">Loading ad performance…</p>}

      {data && (
        <>
          <div className="mkt-kpis">
            <StatGrid>
              <StatCard label="Leads" value={formatCount(totals.counts.leads)} />
              <StatCard
                label="Junk"
                value={formatCount(totals.counts.junk)}
                hint={formatPct(t.junkPct)}
              />
              <StatCard
                label="Closed with sale"
                value={formatCount(totals.counts.won)}
                hint={formatPct(t.winPct)}
              />
              <StatCard label="Closed without sale" value={formatCount(totals.counts.lost)} />
              <StatCard label="Spend" value={formatRupees(totals.spend)} />
              <StatCard label="Cost per sale" value={formatRupees(t.costPerSale)} />
            </StatGrid>
          </div>

          <Section
            title="By campaign, ad set and ad"
            meta={`Leads captured ${formatDay(range.from)} – ${formatDay(range.to)}`}
            flush={campaigns.length > 0}
          >
            {campaigns.length === 0 ? (
              <EmptyState title="No ad leads or spend in this range">
                Try a wider window.
              </EmptyState>
            ) : (
              <DataTable className="mkt-wide adp-table">
                <thead>
                  <tr>
                    <th>Campaign / ad set / ad</th>
                    {COUNT_COLUMNS.map((c) => (
                      <th key={c.key} className="num" title={c.title}>
                        {c.label}
                      </th>
                    ))}
                    <th className="num">Spend</th>
                    <th className="num">CPL</th>
                    <th className="num">Cost / sale</th>
                    <th className="num">Revenue</th>
                    <th className="num">ROAS</th>
                  </tr>
                </thead>
                <tbody>{rows}</tbody>
                <tfoot>
                  <tr>
                    <td>
                      <b>All campaigns</b>
                    </td>
                    <Cells counts={totals.counts} spend={totals.spend} />
                  </tr>
                </tfoot>
              </DataTable>
            )}
            <p className="subtle mkt-note">
              Leads are Meta form fills plus landing-page leads matched to a campaign, picked by
              capture date; the outcome is what the Bigin deal says today. Junk + Lost + Won +
              Pipeline + No deal = Leads. One person on the same ad counts once. Junk is a lost
              deal with reason Wrong Number, Wrong Course/Level or Language Issue.
              {!data.adSpendAvailable &&
                ' Ad set and ad spend appear after the next Meta sync; campaign spend is complete.'}
            </p>
          </Section>
        </>
      )}
    </>
  );
}
