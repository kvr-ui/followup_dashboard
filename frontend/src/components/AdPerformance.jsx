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

// The Ad Performance tab — the full funnel (Leads → MQL → SQL → Pipeline → Won)
// per campaign, ad set and ad, against the spend; and the same funnel grouped by
// source / medium ("which channel works best"). Renders GET /api/ads/performance
// verbatim; the only client-side maths is the per-row rates in
// adStats.performanceRates.
//
// TWO VIEWS, TWO UNIVERSES (the backend's rule, restated in the footnote): the
// campaign tree counts only ad-attributed leads, the source view counts every
// capture — so the source view's totals are the larger ones, by design.
//
// The outcome columns do not overlap (Junk + Lost + Won + Pipeline + No deal =
// Leads; Lost and No deal live in the Leads cell's tooltip). MQL and SQL are
// cumulative funnel counts that overlap them: Leads ≥ MQL ≥ SQL.

const COUNT_COLUMNS = [
  { key: 'leads', label: 'Leads', title: 'Hover for Lost / No deal — the columns that left the grid' },
  { key: 'mql', label: 'MQL', title: 'Exists as a Bigin contact (LeadChain leads are contacts; web/Meta leads match by phone)' },
  { key: 'mqlPct', label: 'MQL %', rate: true, title: 'MQL as % of leads' },
  { key: 'sql', label: 'SQL', title: 'Has any Bigin deal, or any call over 30s — whenever it happened' },
  { key: 'sqlPct', label: 'SQL %', rate: true, title: 'SQL as % of MQL' },
  { key: 'pipeline', label: 'Pipeline', title: 'Deal still open — click the count for the stage breakdown' },
  { key: 'won', label: 'Won', title: 'Closed with sale' },
  { key: 'winPct', label: 'Win %', rate: true, title: 'Won as % of leads' },
  { key: 'junk', label: 'Junk', title: 'Lost with reason Wrong Number, Wrong Course/Level or Language Issue' },
];

// Name column + counts + Spend, CPL, Cost/sale, Revenue, ROAS.
const N_COLS = 1 + COUNT_COLUMNS.length + 5;

const q = (range) => `from=${range.from}&to=${range.to}`;

function Cells({ counts, spend, stages, expanded, onToggle }) {
  const r = performanceRates(counts, spend);
  const leadsTitle = `Lost (excl. junk): ${counts.lost || 0} · No deal yet: ${counts.noDeal || 0}`;
  return (
    <>
      {COUNT_COLUMNS.map((c) => {
        if (c.key === 'pipeline' && stages && onToggle) {
          return (
            <td key={c.key} className="num">
              <button
                type="button"
                className="adp-pipe"
                onClick={onToggle}
                aria-expanded={expanded}
                title="Open deals by Bigin stage"
              >
                {formatCount(counts.pipeline)} {expanded ? '▾' : '▸'}
              </button>
            </td>
          );
        }
        return (
          <td key={c.key} className="num" title={c.key === 'leads' ? leadsTitle : undefined}>
            {c.rate ? formatPct(r[c.key]) : formatCount(counts[c.key])}
          </td>
        );
      })}
      <td className="num">{formatRupees(spend)}</td>
      <td className="num">{formatRupees(r.cpl)}</td>
      <td className="num">{formatRupees(r.costPerSale)}</td>
      <td className="num">{formatRupees(counts.revenue)}</td>
      <td className="num">{r.roas == null ? '—' : `${r.roas.toFixed(2)}×`}</td>
    </>
  );
}

/** The expanded pipeline breakdown: one full-width row of "stage: count" pairs. */
function StagesRow({ rowKey, stages }) {
  return (
    <tr key={rowKey} className="adp-ad">
      <td colSpan={N_COLS}>
        <div className="adp-name adp-indent-2">
          <span className="adp-toggle-spacer" />
          <span className="subtle">
            Open deals by stage —{' '}
            {Object.entries(stages)
              .map(([stage, n]) => `${stage}: ${n}`)
              .join(' · ')}
          </span>
        </div>
      </td>
    </tr>
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

const KIND_TITLES = {
  utm: 'Landing-page leads, grouped by utm_source · utm_medium',
  src: "Bigin contacts, grouped by the rep's Lead Source (canonicalised)",
  meta: 'Meta instant-form leads',
};

export default function AdPerformance() {
  const [range, setRange] = useState(defaultRange);
  const [view, setView] = useState('tree'); // 'tree' | 'source'
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(() => new Set());
  const [openStages, setOpenStages] = useState(() => new Set());

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

  const toggleIn = (setter) => (key) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggle = toggleIn(setOpen);
  const toggleStages = toggleIn(setOpenStages);

  const totals = data && data.totals;
  const sourceTotals = data && data.sourceTotals;
  const campaigns = (data && data.campaigns) || [];
  const sources = (data && data.sources) || [];

  // One row + its optional expanded stage breakdown.
  const pushRow = (rows, key, nameCell, node, spend, rowClass) => {
    const expanded = openStages.has(key);
    rows.push(
      <tr key={key} className={rowClass}>
        <td>{nameCell}</td>
        <Cells
          counts={node.counts}
          spend={spend}
          stages={node.stages}
          expanded={expanded}
          onToggle={node.stages ? () => toggleStages(key) : undefined}
        />
      </tr>
    );
    if (expanded && node.stages) rows.push(<StagesRow key={`${key}:stages`} rowKey={`${key}:stages`} stages={node.stages} />);
  };

  // --- Campaign → ad set → ad rows ------------------------------------------
  const treeRows = [];
  for (const c of campaigns) {
    const cKey = `c:${c.id}`;
    const cOpen = open.has(cKey);
    const expandable = c.adsets.length > 0 || c.landingPage;
    pushRow(
      treeRows,
      cKey,
      <div className="adp-name">
        {expandable ? (
          <Toggle open={cOpen} onClick={() => toggle(cKey)} label="campaign" />
        ) : (
          <span className="adp-toggle-spacer" />
        )}
        <span className="who">{nameOr(c.name, c.id, 'Unknown campaign')}</span>
      </div>,
      c,
      c.spend,
      'adp-campaign'
    );
    if (!cOpen) continue;

    for (const s of c.adsets) {
      const sKey = `s:${c.id}:${s.id}`;
      const sOpen = open.has(sKey);
      pushRow(
        treeRows,
        sKey,
        <div className="adp-name adp-indent-1">
          <Toggle open={sOpen} onClick={() => toggle(sKey)} label="ad set" />
          <span>{nameOr(s.name, s.id, 'Unknown ad set')}</span>
        </div>,
        s,
        s.spend,
        'adp-adset'
      );
      if (!sOpen) continue;
      for (const a of s.ads) {
        pushRow(
          treeRows,
          `a:${c.id}:${s.id}:${a.id}`,
          <div className="adp-name adp-indent-2">
            <span className="adp-toggle-spacer" />
            <span>{nameOr(a.name, a.id, 'Unknown ad')}</span>
          </div>,
          a,
          a.spend,
          'adp-ad'
        );
      }
      if (s.noAd) {
        pushRow(
          treeRows,
          `na:${c.id}:${s.id}`,
          <div className="adp-name adp-indent-2">
            <span className="adp-toggle-spacer" />
            <span className="subtle" title="LeadChain records the ad set, not the ad; a web lead's utm_content may not match an ad">
              Ad not tracked
            </span>
          </div>,
          s.noAd,
          null,
          'adp-ad'
        );
      }
    }

    if (c.landingPage) {
      pushRow(
        treeRows,
        `lp:${c.id}`,
        <div className="adp-name adp-indent-1">
          <span className="adp-toggle-spacer" />
          <span className="subtle">Landing page (ad unknown)</span>
        </div>,
        c.landingPage,
        null,
        'adp-adset'
      );
    }
  }

  // --- Source / medium rows --------------------------------------------------
  const sourceRows = [];
  for (const s of sources) {
    pushRow(
      sourceRows,
      `src:${s.key}`,
      <div className="adp-name">
        <span className="adp-toggle-spacer" />
        <span className="who" title={KIND_TITLES[s.kind]}>
          {s.label}
        </span>
      </div>,
      s,
      null,
      'adp-campaign'
    );
  }

  const isTree = view === 'tree';
  const kpiCounts = isTree ? totals && totals.counts : sourceTotals && sourceTotals.counts;
  const kpiRates = kpiCounts ? performanceRates(kpiCounts, isTree ? totals.spend : null) : null;

  return (
    <>
      <PageHeader
        actions={
          <DateRangeBar range={range} onChange={setRange}>
            <label>
              View
              <select value={view} onChange={(e) => setView(e.target.value)}>
                <option value="tree">By campaign / ad set / ad</option>
                <option value="source">By source / medium</option>
              </select>
            </label>
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
              <StatCard label="Leads" value={formatCount(kpiCounts.leads)} />
              <StatCard
                label="MQL"
                value={formatCount(kpiCounts.mql)}
                hint={formatPct(kpiRates.mqlPct)}
              />
              <StatCard
                label="SQL"
                value={formatCount(kpiCounts.sql)}
                hint={formatPct(kpiRates.sqlPct)}
              />
              <StatCard label="Pipeline" value={formatCount(kpiCounts.pipeline)} />
              <StatCard
                label="Closed with sale"
                value={formatCount(kpiCounts.won)}
                hint={formatPct(kpiRates.winPct)}
              />
              {isTree ? (
                <StatCard label="Spend" value={formatRupees(totals.spend)} />
              ) : (
                <StatCard
                  label="Junk"
                  value={formatCount(kpiCounts.junk)}
                  hint={formatPct(kpiRates.junkPct)}
                />
              )}
            </StatGrid>
          </div>

          <Section
            title={isTree ? 'By campaign, ad set and ad' : 'By source / medium'}
            meta={`Leads captured ${formatDay(range.from)} – ${formatDay(range.to)}`}
            flush={(isTree ? campaigns : sources).length > 0}
          >
            {(isTree ? campaigns : sources).length === 0 ? (
              <EmptyState title={isTree ? 'No ad leads or spend in this range' : 'No leads in this range'}>
                Try a wider window.
              </EmptyState>
            ) : (
              <DataTable className="mkt-wide adp-table">
                <thead>
                  <tr>
                    <th>{isTree ? 'Campaign / ad set / ad' : 'Source / medium'}</th>
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
                <tbody>{isTree ? treeRows : sourceRows}</tbody>
                <tfoot>
                  <tr>
                    <td>
                      <b>{isTree ? 'All campaigns' : 'All sources'}</b>
                    </td>
                    {isTree ? (
                      <Cells counts={totals.counts} spend={totals.spend} stages={totals.stages} expanded={openStages.has('t:all')} onToggle={totals.stages ? () => toggleStages('t:all') : undefined} />
                    ) : (
                      <Cells counts={sourceTotals.counts} spend={null} stages={sourceTotals.stages} expanded={openStages.has('t:src')} onToggle={sourceTotals.stages ? () => toggleStages('t:src') : undefined} />
                    )}
                  </tr>
                  {isTree && openStages.has('t:all') && totals.stages && (
                    <StagesRow rowKey="t:all:stages" stages={totals.stages} />
                  )}
                  {!isTree && openStages.has('t:src') && sourceTotals.stages && (
                    <StagesRow rowKey="t:src:stages" stages={sourceTotals.stages} />
                  )}
                </tfoot>
              </DataTable>
            )}
            <p className="subtle mkt-note">
              {isTree ? (
                <>
                  Ad-attributed leads only (Meta form leads, LeadChain-tagged Bigin contacts, and
                  landing-page leads whose UTM resolved to a campaign, ad set or ad), picked by capture
                  date; the outcome is what the Bigin deal says today. The source / medium view counts
                  every capture, so its totals run larger.
                </>
              ) : (
                <>
                  Every captured lead — including ones no ad could be matched to — grouped by UTM
                  source · medium (landing pages), the rep&apos;s Lead Source (Bigin contacts) or Meta
                  lead form. The campaign view counts only ad-attributed leads, so its totals run
                  smaller. Spend is a campaign-view concept.
                </>
              )}{' '}
              MQL = exists as a Bigin contact. SQL = any deal or any call over 30s, whenever it
              happened (the Funnel tab windows SQL to the contact&apos;s month, so its numbers differ).
              Junk + Lost + Won + Pipeline + No deal = Leads; one person on the same{' '}
              {isTree ? 'ad' : 'source'} counts once.
              {isTree &&
                !data.adSpendAvailable &&
                ' Ad set and ad spend appear after the next Meta sync; campaign spend is complete.'}
            </p>
          </Section>
        </>
      )}
    </>
  );
}
