import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import CopyButton from './CopyButton';

function inr(n) {
  const v = Math.round(n || 0);
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)}Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(2)}L`; // lakhs read better than 9,19,000
  return `₹${v.toLocaleString('en-IN')}`;
}

/**
 * Bigin's Up_Scale reads "Inter G1 - Closed with Sale - (Upsell - Inter G2)" — the
 * only part worth a table cell is what they were upsold TO. Falls back to the raw
 * value if the picklist ever stops following that shape.
 */
function upsoldTo(upScale) {
  if (!upScale) return null;
  const m = upScale.match(/\(\s*upsell\s*-\s*(.+?)\s*\)/i);
  return m ? m[1] : upScale;
}

/** Days since the deal closed — how long the balance has been outstanding. */
function daysSince(closingDate) {
  if (!closingDate) return null;
  const then = new Date(`${closingDate}T00:00:00`);
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(Math.floor((Date.now() - then.getTime()) / 86400000), 0);
}

/**
 * Leads who bought but still owe money.
 *
 * The rep records the OUTSTANDING balance in Bigin's `Installment` field, so the
 * list empties itself: pay the balance, set the field to 0, the lead drops off on
 * the next deal poll. Nothing to tick off here — Bigin stays the source of truth.
 *
 * Sales users see their own leads; the server pins the scope, not this component.
 * Oldest close date first — the longest-outstanding balance is the one to chase.
 */
export default function Installments({ isAdmin }) {
  const [res, setRes] = useState(null);
  const [owner, setOwner] = useState('');
  const [search, setSearch] = useState('');
  const [upsold, setUpsold] = useState(''); // '' | 'yes' | 'no'
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // Non-admins are scoped server-side, so never send an owner for them.
      const q = isAdmin && owner ? `?owner=${encodeURIComponent(owner)}` : '';
      setRes(await api(`/api/installments${q}`));
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

  // The owner dropdown is built from the rows themselves: only reps who actually
  // have money outstanding are worth filtering to.
  const owners = useMemo(() => {
    const m = new Map();
    rows.forEach((r) => {
      if (r.ownerEmail) m.set(r.ownerEmail, r.ownerName || r.ownerEmail);
    });
    return [...m.entries()].map(([email, name]) => ({ email, name }));
  }, [rows]);

  const shown = useMemo(() => {
    const rx = search.trim()
      ? new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      : null;
    return rows.filter((r) => {
      if (upsold === 'yes' && !r.upScale) return false;
      if (upsold === 'no' && r.upScale) return false;
      if (!rx) return true;
      return (
        rx.test(r.contactName || '') || rx.test(r.contactPhone || '') || rx.test(r.dealName || '')
      );
    });
  }, [rows, search, upsold]);

  // Totals come from the server (the whole set), not from `shown` — a filtered
  // page total would quietly under-report how much is actually outstanding.
  const totalPending = res?.totalPending || 0;
  const totalPaid = res?.totalPaid || 0;
  const collected = totalPending + totalPaid
    ? Math.round((totalPaid / (totalPending + totalPaid)) * 100)
    : 0;

  return (
    <>
      <div className="summary-grid">
        <div className="card">
          <div className="num">{res?.count ?? '—'}</div>
          <div className="label">Leads still paying</div>
        </div>
        <div className="card week">
          <div className="num" style={{ color: 'var(--red, #c0392b)' }}>{inr(totalPending)}</div>
          <div className="label">Pending to collect</div>
        </div>
        <div className="card">
          <div className="num" style={{ color: 'var(--green, #27ae60)' }}>{inr(totalPaid)}</div>
          <div className="label">Already paid</div>
        </div>
        <div className="card">
          <div className="num">{collected}%</div>
          <div className="label">Of these deals collected</div>
        </div>
        <div className="card">
          <div className="num" style={{ color: 'var(--green, #27ae60)' }}>
            {res?.upsold ?? '—'}
          </div>
          <div className="label">Upsold, still paying</div>
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
          Upsell
          <select value={upsold} onChange={(e) => setUpsold(e.target.value)}>
            <option value="">All</option>
            <option value="yes">Upsold only</option>
            <option value="no">Not upsold</option>
          </select>
        </label>
        <label>
          Search
          <input
            type="text"
            placeholder="Name, phone or deal"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <button onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      <p id="status">
        {shown.length} lead{shown.length === 1 ? '' : 's'} with a pending balance —{' '}
        {inr(shown.reduce((a, r) => a + r.pending, 0))} shown of {inr(totalPending)} total
      </p>

      <div className="card" style={{ padding: '16px 18px' }}>
        <table className="tasks">
          <thead>
            <tr>
              <th>Lead</th>
              <th>Phone</th>
              <th>Course</th>
              <th>Upsell</th>
              {isAdmin && <th>Owner</th>}
              <th>Closed</th>
              <th style={{ textAlign: 'right' }}>Deal value</th>
              <th style={{ textAlign: 'right' }}>Paid</th>
              <th style={{ textAlign: 'right' }}>Pending</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const age = daysSince(r.closingDate);
              // 60+ days outstanding is the point where a plan has quietly stalled.
              const stale = age !== null && age >= 60;
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
                  <td className="subtle">{r.products.join(', ') || r.dealName || '—'}</td>
                  <td>
                    {r.upScale ? (
                      <span
                        title={r.upScale}
                        style={{
                          display: 'inline-block',
                          padding: '2px 8px',
                          borderRadius: 10,
                          fontSize: '0.72rem',
                          fontWeight: 600,
                          whiteSpace: 'nowrap',
                          color: 'var(--green, #27ae60)',
                          background: 'var(--surface-inset)',
                        }}
                      >
                        ↑ {upsoldTo(r.upScale)}
                      </span>
                    ) : (
                      <span className="subtle">—</span>
                    )}
                  </td>
                  {isAdmin && <td className="subtle">{r.ownerName || r.ownerEmail || '—'}</td>}
                  <td className="subtle">
                    {r.closingDate || '—'}
                    {age !== null && (
                      <span
                        style={{
                          marginLeft: 6,
                          fontSize: '0.72rem',
                          color: stale ? 'var(--red, #c0392b)' : 'inherit',
                          fontWeight: stale ? 600 : 400,
                        }}
                      >
                        ({age}d)
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }} className="subtle">
                    {inr(r.amount)}
                  </td>
                  <td style={{ textAlign: 'right', color: 'var(--green, #27ae60)' }}>
                    {inr(r.paid)}
                  </td>
                  <td
                    style={{
                      textAlign: 'right',
                      fontWeight: 600,
                      color: 'var(--red, #c0392b)',
                    }}
                  >
                    {inr(r.pending)}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && !loading && (
              <tr>
                <td colSpan={isAdmin ? 9 : 8} className="subtle">
                  {rows.length === 0
                    ? 'No pending instalments. A lead appears here once a won deal has an Installment balance set in Bigin.'
                    : 'No leads match your search.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="subtle" style={{ marginTop: 12, fontSize: '0.75rem' }}>
          Pending is Bigin&apos;s <strong>Installment</strong> field — the balance the lead
          still owes on a won deal. Collect the money and set it to 0 in Bigin; the lead
          drops off this list automatically. Won deals with no balance recorded never
          appear here.
        </div>
      </div>
    </>
  );
}
