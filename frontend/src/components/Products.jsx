import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';

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
      <div className="summary-grid">
        <div className="card">
          <div className="num">{products.length}</div>
          <div className="label">Products sold</div>
        </div>
        <div className="card">
          <div className="num" style={{ color: 'var(--green)' }}>{inr(totalRevenue)}</div>
          <div className="label">Total revenue</div>
        </div>
        <div className="card">
          <div className="num">{totalDeals}</div>
          <div className="label">Deals with a product</div>
        </div>
        <div className="card week">
          <div className="num">{top3Share}%</div>
          <div className="label">Revenue from the top 3</div>
        </div>
        <div className="card">
          <div className="num">{outcomes?.won ?? '—'}</div>
          <div className="label">Won deals (total)</div>
        </div>
      </div>

      <div className="filters">
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
        <button onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      <p id="status">
        {products.length} product{products.length === 1 ? '' : 's'} across {totalDeals} won
        deal{totalDeals === 1 ? '' : 's'} — {inr(totalRevenue)} total
      </p>

      <div className="card" style={{ padding: '16px 18px' }}>
        <table className="tasks">
          <thead>
            <tr>
              <th style={{ width: 40 }}>#</th>
              <th>Product</th>
              <th style={{ width: '38%' }}>Share of revenue</th>
              <th style={{ textAlign: 'right' }}>Revenue</th>
              <th style={{ textAlign: 'right' }}>Deals</th>
              <th style={{ textAlign: 'right' }}>Avg / deal</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p, i) => {
              const top = i === 0;
              const bottom = i === products.length - 1;
              return (
                <tr key={p.name}>
                  <td className="subtle">{i + 1}</td>
                  <td style={{ fontWeight: top ? 600 : 400 }}>{p.name}</td>
                  <td>
                    <span
                      style={{
                        display: 'block',
                        background: 'var(--surface-inset)',
                        borderRadius: 4,
                        height: 14,
                        overflow: 'hidden',
                      }}
                    >
                      <span
                        style={{
                          display: 'block',
                          height: '100%',
                          width: `${Math.max((p.revenue / max) * 100, 1)}%`,
                          background: top
                            ? 'var(--green, #27ae60)'
                            : bottom
                              ? 'var(--red, #c0392b)'
                              : 'var(--accent, #6b8afd)',
                          opacity: top || bottom ? 1 : 0.55,
                        }}
                      />
                    </span>
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{inr(p.revenue)}</td>
                  <td style={{ textAlign: 'right' }} className="subtle">
                    {p.deals}
                  </td>
                  <td style={{ textAlign: 'right' }} className="subtle">
                    {inr(p.revenue / (p.deals || 1))}
                  </td>
                </tr>
              );
            })}
            {products.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="subtle">
                  No products found. Products are attached to deals in Bigin when the sale
                  is made.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="subtle" style={{ marginTop: 12, fontSize: '0.75rem' }}>
          Won deals only — products are attached in Bigin when the sale is made, so lost
          deals carry none. That means this shows what <em>earns</em>, not what{' '}
          <em>converts</em>.
        </div>
      </div>
    </>
  );
}
