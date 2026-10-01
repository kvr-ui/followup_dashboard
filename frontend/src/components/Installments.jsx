import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import CopyButton from './CopyButton';
import LeadLink from './LeadLink';
import PageHeader from './ui/PageHeader';
import FilterBar from './ui/FilterBar';
import DataTable from './ui/DataTable';
import StatCard, { StatGrid } from './ui/StatCard';
import EmptyState from './ui/EmptyState';
import Icon from './ui/Icon';
import { rowPhoneKey } from '../route';
import { inr, upsoldTo } from '../upsell';
import '../styles/views/deals.css';

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
      <StatGrid>
        <StatCard label="Leads still paying" value={res?.count ?? '—'} />
        <StatCard label="Pending to collect" value={inr(totalPending)} tone="red" />
        <StatCard label="Already paid" value={inr(totalPaid)} tone="green" />
        <StatCard label="Of these deals collected" value={`${collected}%`} />
        <StatCard label="Upsold, still paying" value={res?.upsold ?? '—'} tone="green" />
      </StatGrid>

      <FilterBar>
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
      </FilterBar>

      {error && <div className="error">{error}</div>}

      <PageHeader
        meta={
          <span id="status">
            {shown.length} lead{shown.length === 1 ? '' : 's'} with a pending balance —{' '}
            {inr(shown.reduce((a, r) => a + r.pending, 0))} shown of {inr(totalPending)} total
          </span>
        }
        actions={
          <button onClick={load} disabled={loading}>
            <Icon name="refresh" size={14} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        }
      />

      {shown.length === 0 && !loading ? (
        <EmptyState title={rows.length === 0 ? 'No pending instalments' : 'No leads match your search'}>
          {rows.length === 0 &&
            'A lead appears here once a won deal has an Installment balance set in Bigin.'}
        </EmptyState>
      ) : (
        <DataTable>
          <thead>
            <tr>
              <th>Lead</th>
              <th>Phone</th>
              <th>Course</th>
              <th>Upsell</th>
              {isAdmin && <th>Owner</th>}
              <th>Closed</th>
              <th className="num">Deal value</th>
              <th className="num">Paid</th>
              <th className="num">Pending</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const age = daysSince(r.closingDate);
              // 60+ days outstanding is the point where a plan has quietly stalled.
              const stale = age !== null && age >= 60;
              return (
                <tr key={r.id}>
                  <td className="deals-lead">
                    <LeadLink phoneKey={rowPhoneKey(r, r.contactPhone)}>
                      {r.contactName || r.dealName || '—'}
                    </LeadLink>
                  </td>
                  <td>
                    {r.contactPhone ? (
                      <span className="deals-phone">
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
                      <span title={r.upScale} className="deals-upsell-pill">
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
                      <span className={stale ? 'deals-age stale' : 'deals-age'}>({age}d)</span>
                    )}
                  </td>
                  <td className="num subtle">{inr(r.amount)}</td>
                  <td className="num deals-paid">{inr(r.paid)}</td>
                  <td className="num deals-loss">{inr(r.pending)}</td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}

      <p className="subtle deals-note">
        Pending is Bigin&apos;s <strong>Installment</strong> field — the balance the lead
        still owes on a won deal. Collect the money and set it to 0 in Bigin; the lead
        drops off this list automatically. Won deals with no balance recorded never
        appear here.
      </p>
    </>
  );
}
