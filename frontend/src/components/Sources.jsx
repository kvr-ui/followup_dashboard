import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import DateRangeBar from './DateRangeBar';
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
      <div className="mkt-head">
        <h2>Sources</h2>
        <DateRangeBar
          range={{
            from: range.from || '2020-01-01',
            to: range.to || localIso(new Date()),
            label: range.label,
          }}
          onChange={(r) => setRange(r)}
        >
          <button
            type="button"
            className={allTime ? 'mkt-preset mkt-preset-on' : 'mkt-preset'}
            onClick={() => setRange(ALL_TIME)}
          >
            All time
          </button>
          <button onClick={() => load(range)} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </DateRangeBar>
      </div>

      {error && <div className="error">{error}</div>}
      {!data && !error && <p className="subtle">Loading source breakdown…</p>}

      {data && totals && (
        <>
          <div className="summary-grid">
            <div className="card">
              <div className="num mkt-num" style={{ color: 'var(--green)' }}>
                {inr(totals.revenue)}
              </div>
              <div className="label">Revenue closed</div>
            </div>
            <div className="card">
              <div className="num mkt-num">{formatCount(totals.won)}</div>
              <div className="label">Deals won</div>
            </div>
            <div className="card">
              <div className="num mkt-num">{formatPct(totals.winRate)}</div>
              <div className="label">Win rate (of closed)</div>
            </div>
            <div className="card">
              <div className="num mkt-num">{inr(totals.paidMetaRevenue)}</div>
              <div className="label">From paid Meta</div>
            </div>
            <div className="card">
              <div className="num mkt-num">{formatCount(selling.length)}</div>
              <div className="label">Channels that sell</div>
            </div>
            <div className="card week">
              <div className="num mkt-num">{formatPct(data.coverage.pct)}</div>
              <div className="label">Deals with a source</div>
            </div>
          </div>

          <p className="subtle mkt-note">
            {allTime ? 'All time' : `${formatDay(range.from)} – ${formatDay(range.to)}`} ·{' '}
            {formatCount(totals.closed)} closed deal(s), {formatCount(totals.open)} still open.
            Win rate is won ÷ closed — open deals are shown but never in the denominator,
            because the mirror holds every closed deal and only part of the open pipeline.
          </p>

          {/* ---------------- Which channel closes ---------------- */}
          <div className="panel">
            <div className="row-between mkt-panel-head">
              <h2>Where the sales came from</h2>
              <span className="subtle">
                {formatCount(data.coverage.dealsWithSource)} of{' '}
                {formatCount(data.coverage.dealsTotal)} deals carry a source
              </span>
            </div>

            <div className="mkt-scroll">
              <table className="tasks mkt-table">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th style={{ width: '22%' }}>Share of revenue</th>
                    <th className="mkt-right">Revenue</th>
                    <th className="mkt-right">Won</th>
                    <th className="mkt-right">Lost</th>
                    <th className="mkt-right">Open</th>
                    <th className="mkt-right">Win rate</th>
                    <th className="mkt-right">Avg sale</th>
                    <th className="mkt-right" title="Won deals traceable to a Meta ad by lead id">
                      Ad-traced
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {selling.map((s, i) => (
                    <tr key={s.source}>
                      <td>
                        <span style={{ fontWeight: i === 0 ? 600 : 400 }}>{s.source}</span>
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
                            className="src-bar-fill"
                            style={{
                              width: `${Math.max((s.revenue / maxRevenue) * 100, 1)}%`,
                              background: s.paidMeta
                                ? 'var(--accent, #6b8afd)'
                                : 'var(--green, #27ae60)',
                              opacity: i === 0 ? 1 : 0.6,
                            }}
                          />
                        </span>
                      </td>
                      <td className="mkt-right" style={{ fontWeight: 600 }}>
                        {inr(s.revenue)}
                      </td>
                      <td className="mkt-right">{formatCount(s.won)}</td>
                      <td className="mkt-right subtle">{formatCount(s.lost)}</td>
                      <td className="mkt-right subtle">{formatCount(s.open)}</td>
                      <td className="mkt-right">{formatPct(s.winRate)}</td>
                      <td className="mkt-right subtle">{inr(s.avgSale)}</td>
                      <td className="mkt-right subtle">
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
                      <td className="mkt-right subtle">—</td>
                      <td className="mkt-right subtle">0</td>
                      <td className="mkt-right subtle">{formatCount(s.lost)}</td>
                      <td className="mkt-right subtle">{formatCount(s.open)}</td>
                      <td className="mkt-right subtle">{formatPct(s.winRate)}</td>
                      <td className="mkt-right subtle">—</td>
                      <td className="mkt-right subtle">0/0</td>
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
              </table>
            </div>

            <div className="subtle mkt-note">
              The source is Bigin&apos;s <code>Lead_Source1</code> on the contact — a free-text
              field, so spellings are merged into the names above and the originals are
              listed underneath each row. Make it a picklist in Bigin and this merge
              stops mattering.
            </div>
          </div>

          {/* ---------------- Back to the campaign ---------------- */}
          <div className="panel">
            <div className="row-between mkt-panel-head">
              <h2>Meta: from the sale back to the campaign</h2>
              <span className="subtle">
                {formatCount(meta.wonWithLeadId)} won deal(s) carry a Meta lead id
              </span>
            </div>

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
                <div className="mkt-scroll">
                  <table className="tasks mkt-table">
                    <thead>
                      <tr>
                        <th>Campaign</th>
                        <th className="mkt-right">Won</th>
                        <th className="mkt-right">Revenue</th>
                        <th className="mkt-right">Spend</th>
                        <th className="mkt-right">ROAS</th>
                        <th className="mkt-right">Cost per sale</th>
                      </tr>
                    </thead>
                    <tbody>
                      {meta.campaigns.map((c) => (
                        <tr key={c.campaignId || 'unknown'}>
                          <td>{c.name || <span className="subtle">{c.campaignId || 'Unknown campaign'}</span>}</td>
                          <td className="mkt-right">{formatCount(c.won)}</td>
                          <td className="mkt-right" style={{ fontWeight: 600 }}>{inr(c.revenue)}</td>
                          <td className="mkt-right subtle">{inr(c.spend)}</td>
                          <td className="mkt-right">{c.roas == null ? '—' : `${c.roas}×`}</td>
                          <td className="mkt-right subtle">{inr(c.cac)}</td>
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
                  </table>
                </div>

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
          </div>
        </>
      )}
    </>
  );
}
