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
import { inr, upsoldFrom, upsoldTo } from '../upsell';
import '../styles/views/deals.css';

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
      <StatGrid>
        <StatCard label="Leads upsold" value={res?.count ?? '—'} />
        <StatCard
          label={`Of ${res?.wonCount ?? 0} won deals`}
          value={`${res?.upsellRate ?? 0}%`}
          tone="accent"
        />
        <StatCard label="Value of upsold deals" value={inr(res?.totalValue)} tone="green" />
        <StatCard
          label="Extra revenue booked"
          value={inr(res?.totalUplift)}
          tone={res?.totalUplift > 0 ? 'green' : undefined}
        />
        <StatCard
          label="Upsells earning nothing"
          value={noUplift}
          tone={noUplift ? 'red' : undefined}
        />
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
          Search
          <input
            type="text"
            placeholder="Name, phone or course"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </FilterBar>

      {error && <div className="error">{error}</div>}

      <PageHeader
        meta={
          <span id="status">
            {shown.length} upsold lead{shown.length === 1 ? '' : 's'}
          </span>
        }
        actions={
          <button onClick={load} disabled={loading}>
            <Icon name="refresh" size={14} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        }
      />

      {noUplift > 0 && (
        <p className="error">
          {noUplift} upsell{noUplift === 1 ? '' : 's'} booked no extra revenue — the deal
          is still priced like the original course. Check the Amount and the products in
          Bigin.
        </p>
      )}

      {shown.length === 0 && !loading ? (
        <EmptyState title={rows.length === 0 ? 'No upsells yet' : 'No leads match your search'}>
          {rows.length === 0 &&
            'A lead appears here once a won deal has the Up-Scale field set in Bigin.'}
        </EmptyState>
      ) : (
        <DataTable>
          <thead>
            <tr>
              <th>Lead</th>
              <th>Phone</th>
              <th>Upsold</th>
              {isAdmin && <th>Owner</th>}
              <th>Closed</th>
              <th className="num">Deal value</th>
              <th className="num">Typical</th>
              <th className="num">Uplift</th>
              <th className="num">Payment</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const from = upsoldFrom(r.upScale);
              const to = upsoldTo(r.upScale);
              const dead = r.uplift !== null && r.uplift <= 0;
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
                  <td title={r.upScale} className="deals-nowrap">
                    {from && <span className="subtle">{from} </span>}
                    <span className="deals-up">↑ {to}</span>
                  </td>
                  {isAdmin && <td className="subtle">{r.ownerName || r.ownerEmail || '—'}</td>}
                  <td className="subtle">{r.closingDate || '—'}</td>
                  <td className="num">{inr(r.amount)}</td>
                  <td className="num subtle">{r.typical == null ? '—' : inr(r.typical)}</td>
                  <td
                    className={
                      r.uplift === null ? 'num deals-strong' : dead ? 'num deals-loss' : 'num deals-gain'
                    }
                    title={
                      r.uplift === null
                        ? 'No baseline: this course has never been sold without an upsell.'
                        : `Deal value minus the ${inr(r.typical)} this course normally sells for.`
                    }
                  >
                    {r.uplift === null ? '—' : dead ? `${inr(r.uplift)} ⚠` : `+${inr(r.uplift)}`}
                  </td>
                  <td className="num">
                    {r.pending > 0 ? (
                      <span className="deals-due">{inr(r.pending)} due</span>
                    ) : (
                      <span className="subtle">Paid</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}

      <p className="subtle deals-note">
        <strong>Uplift</strong> is the deal value minus what that course normally sells
        for (the median won deal for the same product, company-wide). Bigin doesn&apos;t
        store the pre-upsell price, so this is the closest honest measure of what the
        upsell earned — a <strong>₹0 uplift means the deal is still priced like the
        original course</strong>, so the upsell brought in no money on paper.
      </p>
    </>
  );
}
