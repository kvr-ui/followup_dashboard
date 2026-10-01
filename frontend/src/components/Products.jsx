import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import PageHeader from './ui/PageHeader';
import FilterBar from './ui/FilterBar';
import DataTable from './ui/DataTable';
import StatCard, { StatGrid } from './ui/StatCard';
import EmptyState from './ui/EmptyState';
import Icon from './ui/Icon';
import '../styles/views/deals.css';

function inr(n) {
  const v = Math.round(n || 0);
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)}Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(2)}L`; // lakhs read better than 9,19,000
  return `₹${v.toLocaleString('en-IN')}`;
}

/**
 * What actually sells.
 *
 * WON deals only — and that is not a limitation we chose, it is what the data is.
 * Products get attached in Bigin when the sale is made, so lost deals carry none
 * (we sampled 50 across the whole set: 2 had products). A "win rate per product"
 * would therefore be noise dressed up as a number, so we don't show one.
 */
export default function Products() {
  const [outcomes, setOutcomes] = useState(null);
  const [owner, setOwner] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const o = await api(
        `/api/calls/outcomes${owner ? `?owner=${encodeURIComponent(owner)}` : ''}`
      );
      setOutcomes(o);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [owner]);

  useEffect(() => {
    load();
  }, [load]);

  const products = useMemo(() => outcomes?.products || [], [outcomes]);
  const owners = useMemo(
    () => (outcomes?.byOwner || []).filter((o) => o.ownerEmail),
    [outcomes]
  );

  // Bar length is relative to the best seller, so the spread is visible at a glance.
  const max = useMemo(() => Math.max(...products.map((p) => p.revenue), 1), [products]);
  const totalRevenue = useMemo(
    () => products.reduce((a, p) => a + p.revenue, 0),
    [products]
  );
  const totalDeals = useMemo(() => products.reduce((a, p) => a + p.deals, 0), [products]);

  // The top 3 usually ARE the business — worth saying so out loud.
  const top3Share = useMemo(() => {
    if (!totalRevenue) return 0;
    const top3 = products.slice(0, 3).reduce((a, p) => a + p.revenue, 0);
    return Math.round((top3 / totalRevenue) * 100);
  }, [products, totalRevenue]);

  return (
    <>
      <StatGrid>
        <StatCard label="Products sold" value={products.length} />
        <StatCard label="Total revenue" value={inr(totalRevenue)} tone="green" />
        <StatCard label="Deals with a product" value={totalDeals} />
        <StatCard label="Revenue from the top 3" value={`${top3Share}%`} tone="accent" />
        <StatCard label="Won deals (total)" value={outcomes?.won ?? '—'} />
      </StatGrid>

      <FilterBar>
        <label>
          Salesperson
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">All</option>
            {owners.map((o) => (
              <option key={o.ownerEmail} value={o.ownerEmail}>
                {o.ownerName || o.ownerEmail} ({o.won}W / {o.lost}L)
              </option>
            ))}
          </select>
        </label>
      </FilterBar>

      {error && <div className="error">{error}</div>}

      <PageHeader
        meta={
          <span id="status">
            {products.length} product{products.length === 1 ? '' : 's'} across {totalDeals} won
            deal{totalDeals === 1 ? '' : 's'} — {inr(totalRevenue)} total
          </span>
        }
        actions={
          <button onClick={load} disabled={loading}>
            <Icon name="refresh" size={14} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        }
      />

      {products.length === 0 && !loading ? (
        <EmptyState title="No products found">
          Products are attached to deals in Bigin when the sale is made.
        </EmptyState>
      ) : (
        <DataTable>
          <thead>
            <tr>
              <th className="deals-rank-col">#</th>
              <th>Product</th>
              <th className="deals-share-col">Share of revenue</th>
              <th className="num">Revenue</th>
              <th className="num">Deals</th>
              <th className="num">Avg / deal</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p, i) => {
              const top = i === 0;
              const bottom = i === products.length - 1;
              return (
                <tr key={p.name}>
                  <td className="subtle">{i + 1}</td>
                  <td className={top ? 'deals-strong' : undefined}>{p.name}</td>
                  <td>
                    <span className="deals-share">
                      <span
                        className={`deals-share-fill ${top ? 'top' : bottom ? 'bottom' : ''}`.trim()}
                        style={{ width: `${Math.max((p.revenue / max) * 100, 1)}%` }}
                      />
                    </span>
                  </td>
                  <td className="num deals-strong">{inr(p.revenue)}</td>
                  <td className="num subtle">{p.deals}</td>
                  <td className="num subtle">{inr(p.revenue / (p.deals || 1))}</td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}

      <p className="subtle deals-note">
        Won deals only — products are attached in Bigin when the sale is made, so lost
        deals carry none. That means this shows what <em>earns</em>, not what{' '}
        <em>converts</em>.
      </p>
    </>
  );
}
