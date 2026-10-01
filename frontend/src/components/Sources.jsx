import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import DateRangeBar from './DateRangeBar';
import PageHeader from './ui/PageHeader';
import Section from './ui/Section';
import DataTable from './ui/DataTable';
import StatCard, { StatGrid } from './ui/StatCard';
import Icon from './ui/Icon';
import { formatCount, formatDay, formatPct, formatRupees, localIso } from '../adStats';

// The Sources tab — which lead source actually closes the deal, and for the ones
// that came from an ad, which campaign paid for them.
//
// WHY THIS IS NOT INSIDE MARKETING
// --------------------------------
// Marketing answers "what did the ads do": spend, CTR, cost per lead — all of it
// capture-side, all of it Meta's own numbers, all of it windowed on Meta insight
// rows that only go back a few weeks. This answers "what did we SELL and where
// did it come from", which is CRM-side, covers the whole history, and includes
// the channels Meta has never heard of — WhatsApp DMs and student registrations
// between them close two thirds of the revenue. Folding the two together would
// mean one date picker over two datasets with different depths, and a reader
// unable to tell which half a number belongs to.
//
// ALL TIME BY DEFAULT, AND THAT IS DELIBERATE
// -------------------------------------------
// Every other admin tab opens on the last 30 days. This one opens on everything,
// because the business closes ~180 deals a LIFETIME: a 30-day window would show
// a dozen sales spread over ten channels and invite conclusions from samples of
// two. The range picker is still there for anyone who wants a quarter.
//
// EVERY NUMBER COMES FROM THE SERVER
// ----------------------------------
// Win rates, revenue shares and the campaign roll-up are computed once in
// modules/ads/services/sourceRollup.js and rendered verbatim. The only thing
// computed here is a bar width.

/** The all-time window: the server treats "no range" as the whole history. */
const ALL_TIME = { from: '', to: '', label: 'All time' };

function inr(value) {
  // `null` is the server's word for "this cannot be computed" — an average sale
  // for a channel that has never sold, a cost per sale with no spend behind it.
  // Number(null) is 0, so without this guard every one of those renders as a
  // confident ₹0.
  if (value == null) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return formatRupees(n);
}

export default function Sources() {
  const [range, setRange] = useState(ALL_TIME);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const allTime = !range.from || !range.to;

  const load = useCallback(async (r) => {
    setLoading(true);
    setError('');
    try {
      // A partial range is rejected by the API rather than half-defaulted, so
      // send both ends or neither — never one.
      const qs = r.from && r.to ? `?from=${r.from}&to=${r.to}` : '';
      const res = await api(`/api/ads/sources${qs}`);
      setData(res.data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(range);
  }, [load, range]);

  const sources = useMemo(() => (data && data.sources) || [], [data]);
  const totals = data && data.totals;
  const meta = data && data.meta;

  // Bar length is relative to the best channel, so the spread reads at a glance.
  const maxRevenue = useMemo(
    () => Math.max(...sources.map((s) => s.revenue), 1),
    [sources]
  );

  // Channels that have never closed anything sit at the bottom and carry no
  // revenue bar. Shown, not hidden — a channel producing leads and no sales is
  // the most actionable row on the page.
  const selling = sources.filter((s) => s.won > 0);
  const barren = sources.filter((s) => s.won === 0);

  return (
    <>
      <PageHeader
        actions={
          <DateRangeBar
            range={{
              from: range.from || '2020-01-01',
              to: range.to || localIso(new Date()),
              label: range.label,
            }}
            onChange={(r) => setRange(r)}
            extra={[{ label: 'All time', active: allTime, onSelect: () => setRange(ALL_TIME) }]}
          >
            <button onClick={() => load(range)} disabled={loading}>
              <Icon name="refresh" size={14} />
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </DateRangeBar>
        }
      />

      {error && <div className="error">{error}</div>}
      {!data && !error && <p className="subtle">Loading source breakdown…</p>}

      {data && totals && (
        <>
          <div className="mkt-kpis">
            <StatGrid>
              <StatCard label="Revenue closed" value={inr(totals.revenue)} tone="green" />
              <StatCard label="Deals won" value={formatCount(totals.won)} />
              <StatCard label="Win rate (of closed)" value={formatPct(totals.winRate)} />
              <StatCard label="From paid Meta" value={inr(totals.paidMetaRevenue)} />
              <StatCard label="Channels that sell" value={formatCount(selling.length)} />
              <StatCard
                label="Deals with a source"
                value={formatPct(data.coverage.pct)}
                tone="accent"
              />
            </StatGrid>
          </div>

          <p className="subtle mkt-note mkt-lead-note">
            {allTime ? 'All time' : `${formatDay(range.from)} – ${formatDay(range.to)}`} ·{' '}
            {formatCount(totals.closed)} closed deal(s), {formatCount(totals.open)} still open.
            Win rate is won ÷ closed — open deals are shown but never in the denominator,
            because the mirror holds every closed deal and only part of the open pipeline.
          </p>

          {/* ---------------- Which channel closes ---------------- */}
          <Section
            title="Where the sales came from"
            meta={`${formatCount(data.coverage.dealsWithSource)} of ${formatCount(
              data.coverage.dealsTotal
            )} deals carry a source`}
            flush
          >
            <DataTable className="mkt-wide">
              <thead>
                <tr>
                  <th>Source</th>
                  <th className="src-share-col">Share of revenue</th>
                  <th className="num">Revenue</th>
                  <th className="num">Won</th>
                  <th className="num">Lost</th>
                  <th className="num">Open</th>
                  <th className="num">Win rate</th>
                  <th className="num">Avg sale</th>
                  <th className="num" title="Won deals traceable to a Meta ad by lead id">
                    Ad-traced
                  </th>
                </tr>
              </thead>
              <tbody>
                {selling.map((s, i) => (
                  <tr key={s.source} className={i === 0 ? 'src-top' : undefined}>
                    <td>
                      <span className="src-name">{s.source}</span>
                      {s.paidMeta && <span className="badge badge-low src-paid">paid</span>}
                      {/* The canonical name stands in for several spellings a rep
                          typed. Say which, or the merge is invisible and unarguable. */}
                      {s.rawValues.length > 1 && (
                        <div className="subtle src-raw" title={s.rawValues.join(' · ')}>
                          {s.rawValues.join(' · ')}
                        </div>
                      )}
                    </td>
                    <td>
                      <span className="src-bar">
                        <span
                          className={s.paidMeta ? 'src-bar-fill src-bar-paid' : 'src-bar-fill'}
                          style={{ width: `${Math.max((s.revenue / maxRevenue) * 100, 1)}%` }}
                        />
                      </span>
                    </td>
                    <td className="num src-strong">{inr(s.revenue)}</td>
                    <td className="num">{formatCount(s.won)}</td>
                    <td className="num subtle">{formatCount(s.lost)}</td>
                    <td className="num subtle">{formatCount(s.open)}</td>
                    <td className="num">{formatPct(s.winRate)}</td>
                    <td className="num subtle">{inr(s.avgSale)}</td>
                    <td className="num subtle">
                      {s.wonWithMetaId}/{s.won}
                    </td>
                  </tr>
                ))}

                {barren.length > 0 && (
                  <tr>
                    <td colSpan={9} className="subtle src-divider">
                      No sale yet from these — leads arrive, nothing closes:
                    </td>
                  </tr>
                )}
                {barren.map((s) => (
                  <tr key={s.source} className="src-barren">
                    <td>{s.source}</td>
                    <td />
                    <td className="num subtle">—</td>
                    <td className="num subtle">0</td>
                    <td className="num subtle">{formatCount(s.lost)}</td>
                    <td className="num subtle">{formatCount(s.open)}</td>
                    <td className="num subtle">{formatPct(s.winRate)}</td>
                    <td className="num subtle">—</td>
                    <td className="num subtle">0/0</td>
                  </tr>
                ))}

                {sources.length === 0 && !loading && (
                  <tr>
                    <td colSpan={9} className="subtle">
                      No deals in this window.
                    </td>
                  </tr>
                )}
              </tbody>
            </DataTable>

            <div className="subtle mkt-note">
              The source is Bigin&apos;s <code>Lead_Source1</code> on the contact — a free-text
              field, so spellings are merged into the names above and the originals are
              listed underneath each row. Make it a picklist in Bigin and this merge
              stops mattering.
            </div>
          </Section>

          {/* ---------------- Back to the campaign ---------------- */}
          <Section
            title="Meta: from the sale back to the campaign"
            meta={`${formatCount(meta.wonWithLeadId)} won deal(s) carry a Meta lead id`}
            flush={meta.available}
          >
            {!meta.available ? (
              // An empty table here would read as "Meta sold nothing", which is a
              // very different claim from "we cannot see what Meta sold".
              <div className="src-blocked">
                <strong>The chain stops at the lead id.</strong>
                <p>{meta.reason}</p>
                <p className="subtle">
                  {formatCount(meta.wonWithLeadId)} won deal(s) are waiting on the other side
                  of it — each one already carries the exact Meta lead id that produced it,
                  so no matching or guesswork is needed once the leads sync.
                </p>
              </div>
            ) : (
              <>
                <DataTable>
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th className="num">Won</th>
                      <th className="num">Revenue</th>
                      <th className="num">Spend</th>
                      <th className="num">ROAS</th>
                      <th className="num">Cost per sale</th>
                    </tr>
                  </thead>
                  <tbody>
                    {meta.campaigns.map((c) => (
                      <tr key={c.campaignId || 'unknown'}>
                        <td>{c.name || <span className="subtle">{c.campaignId || 'Unknown campaign'}</span>}</td>
                        <td className="num">{formatCount(c.won)}</td>
                        <td className="num src-strong">{inr(c.revenue)}</td>
                        <td className="num subtle">{inr(c.spend)}</td>
                        <td className="num">{c.roas == null ? '—' : `${c.roas}×`}</td>
                        <td className="num subtle">{inr(c.cac)}</td>
                      </tr>
                    ))}
                    {meta.campaigns.length === 0 && (
                      <tr>
                        <td colSpan={6} className="subtle">
                          No won deal in this window traced back to a campaign.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </DataTable>

                <div className="subtle mkt-note">
                  Traced by Meta&apos;s own lead id (Bigin&apos;s LeadChain field) — an exact
                  join, no phone or name matching. Spend is the campaign&apos;s{' '}
                  {meta.spendBasis} while revenue is only the deals closed in this window, so
                  read ROAS as a ranking between campaigns, not as an audited return.
                  {meta.unmatchedLeadIds > 0 && (
                    <>
                      {' '}
                      {formatCount(meta.unmatchedLeadIds)} lead id(s) are not in the Meta
                      mirror — their form is not being synced.
                    </>
                  )}
                </div>
              </>
            )}
          </Section>
        </>
      )}
    </>
  );
}
