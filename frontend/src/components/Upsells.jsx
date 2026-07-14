import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import CopyButton from './CopyButton';
import { inr, upsoldFrom, upsoldTo } from '../upsell';

/**
 * Every lead who was upsold — regardless of whether they've finished paying.
 * (The Instalments tab only holds leads who still owe money; an upsold lead who
 * paid in full lives here and nowhere else.)
 *
 * The uplift column is the honest part. Bigin never records what the lead was going
 * to pay BEFORE the upsell, so "revenue gained" can't be read off the deal. The
 * server compares the deal against what that course normally sells for instead, and
 * when a rep ticks the Up_Scale picklist without raising the Amount, the uplift is
 * ₹0 and we say so — rather than counting the base course price as upsell revenue.
 */
export default function Upsells({ isAdmin }) {
  const [res, setRes] = useState(null);
  const [owner, setOwner] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const q = isAdmin && owner ? `?owner=${encodeURIComponent(owner)}` : '';
      setRes(await api(`/api/upsells${q}`));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [isAdmin, owner]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => res?.data || [], [res]);

  const owners = useMemo(() => {
    const m = new Map();
    rows.forEach((r) => {
      if (r.ownerEmail) m.set(r.ownerEmail, r.ownerName || r.ownerEmail);
    });
    return [...m.entries()].map(([email, name]) => ({ email, name }));
  }, [rows]);

  const shown = useMemo(() => {
    if (!search.trim()) return rows;
    const rx = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    return rows.filter(
      (r) =>
        rx.test(r.contactName || '') ||
        rx.test(r.contactPhone || '') ||
        rx.test(r.upScale || '') ||
        rx.test(r.dealName || '')
    );
  }, [rows, search]);

  const noUplift = res?.noUpliftCount || 0;

  return (
    <>
      <div className="summary-grid">
        <div className="card">
          <div className="num">{res?.count ?? '—'}</div>
          <div className="label">Leads upsold</div>
        </div>
        <div className="card week">
          <div className="num">{res?.upsellRate ?? 0}%</div>
          <div className="label">Of {res?.wonCount ?? 0} won deals</div>
        </div>
        <div className="card">
          <div className="num" style={{ color: 'var(--green, #27ae60)' }}>
            {inr(res?.totalValue)}
          </div>
          <div className="label">Value of upsold deals</div>
        </div>
        <div className="card">
          <div
            className="num"
            style={{ color: res?.totalUplift > 0 ? 'var(--green, #27ae60)' : 'inherit' }}
          >
            {inr(res?.totalUplift)}
          </div>
          <div className="label">Extra revenue booked</div>
        </div>
        <div className="card">
          <div
            className="num"
            style={{ color: noUplift ? 'var(--red, #c0392b)' : 'inherit' }}
          >
            {noUplift}
          </div>
          <div className="label">Upsells earning nothing</div>
        </div>
      </div>

      <div className="filters">
        {isAdmin && (
          <label>
            Salesperson
            <select value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">All</option>
              {owners.map((o) => (
                <option key={o.email} value={o.email}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Search
          <input
            type="text"
            placeholder="Name, phone or course"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <button onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {noUplift > 0 && (
        <p id="status" style={{ color: 'var(--red, #c0392b)' }}>
          {noUplift} upsell{noUplift === 1 ? '' : 's'} booked no extra revenue — the deal
          is still priced like the original course. Check the Amount and the products in
          Bigin.
        </p>
      )}

      <div className="card" style={{ padding: '16px 18px' }}>
        <table className="tasks">
          <thead>
            <tr>
              <th>Lead</th>
              <th>Phone</th>
              <th>Upsold</th>
              {isAdmin && <th>Owner</th>}
              <th>Closed</th>
              <th style={{ textAlign: 'right' }}>Deal value</th>
              <th style={{ textAlign: 'right' }}>Typical</th>
              <th style={{ textAlign: 'right' }}>Uplift</th>
              <th style={{ textAlign: 'right' }}>Payment</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const from = upsoldFrom(r.upScale);
              const to = upsoldTo(r.upScale);
              const dead = r.uplift !== null && r.uplift <= 0;
              return (
                <tr key={r.id}>
                  <td style={{ fontWeight: 500 }}>{r.contactName || r.dealName || '—'}</td>
                  <td>
                    {r.contactPhone ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {r.contactPhone}
                        <CopyButton text={r.contactPhone} />
                      </span>
                    ) : (
                      <span className="subtle">—</span>
                    )}
                  </td>
                  <td title={r.upScale} style={{ whiteSpace: 'nowrap' }}>
                    {from && <span className="subtle">{from} </span>}
                    <span style={{ color: 'var(--green, #27ae60)', fontWeight: 600 }}>
                      ↑ {to}
                    </span>
                  </td>
                  {isAdmin && <td className="subtle">{r.ownerName || r.ownerEmail || '—'}</td>}
                  <td className="subtle">{r.closingDate || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{inr(r.amount)}</td>
                  <td style={{ textAlign: 'right' }} className="subtle">
                    {r.typical == null ? '—' : inr(r.typical)}
                  </td>
                  <td
                    style={{
                      textAlign: 'right',
                      fontWeight: 600,
                      color: r.uplift === null
                        ? 'inherit'
                        : dead
                          ? 'var(--red, #c0392b)'
                          : 'var(--green, #27ae60)',
                    }}
                    title={
                      r.uplift === null
                        ? 'No baseline: this course has never been sold without an upsell.'
                        : `Deal value minus the ${inr(r.typical)} this course normally sells for.`
                    }
                  >
                    {r.uplift === null ? '—' : dead ? `${inr(r.uplift)} ⚠` : `+${inr(r.uplift)}`}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {r.pending > 0 ? (
                      <span style={{ color: 'var(--red, #c0392b)' }}>
                        {inr(r.pending)} due
                      </span>
                    ) : (
                      <span className="subtle">Paid</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && !loading && (
              <tr>
                <td colSpan={isAdmin ? 9 : 8} className="subtle">
                  {rows.length === 0
                    ? 'No upsells yet. A lead appears here once a won deal has the Up-Scale field set in Bigin.'
                    : 'No leads match your search.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="subtle" style={{ marginTop: 12, fontSize: '0.75rem' }}>
          <strong>Uplift</strong> is the deal value minus what that course normally sells
          for (the median won deal for the same product, company-wide). Bigin doesn&apos;t
          store the pre-upsell price, so this is the closest honest measure of what the
          upsell earned — a <strong>₹0 uplift means the deal is still priced like the
          original course</strong>, so the upsell brought in no money on paper.
        </div>
      </div>
    </>
  );
}
