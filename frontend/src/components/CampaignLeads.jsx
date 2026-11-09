import { useEffect, useState } from 'react';
import { api, download } from '../api';
import Section from './ui/Section';
import DataTable from './ui/DataTable';
import FilterBar from './ui/FilterBar';
import EmptyState from './ui/EmptyState';
import { formatCount, formatDay, formatRupeesWhole } from '../format';
import { OUTCOME } from '../labels';

// Campaign leads — every Bigin contact created in the page's date range, with
// its campaign, CA status, lead source and how its deal closed. Filters narrow
// the table and both exports; WATI exports split into 500 or 1000 per file.

const NONE = '__none';
const EMPTY = { campaign: '', caStatus: '', source: '', outcome: '', owner: '', q: '' };
const PAGE_SIZE = 50;

function params(range, filters, extra = {}) {
  const p = new URLSearchParams({ from: range.from, to: range.to });
  for (const [k, v] of Object.entries({ ...filters, ...extra })) if (v) p.set(k, v);
  return p.toString();
}

function Options({ items = [], noneLabel, renderLabel = (o) => o.label }) {
  return items.map((o) => (
    <option key={o.value} value={o.value}>
      {o.value === NONE ? noneLabel : renderLabel(o)} ({formatCount(o.count)})
    </option>
  ));
}

export default function CampaignLeads({ range }) {
  const [filters, setFilters] = useState(EMPTY);
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [watiOpen, setWatiOpen] = useState(false);
  const [chunk, setChunk] = useState('500');
  const [exporting, setExporting] = useState('');

  // Debounce the search box into the filters.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === search ? f : { ...f, q: search })), 300);
    return () => clearTimeout(t);
  }, [search]);

  // The page belongs to one filter set: any filter or range change is page 1
  // again, without a second effect (and a second fetch) to reset it.
  const filterKey = JSON.stringify([range.from, range.to, filters]);
  const [paging, setPaging] = useState({ key: filterKey, page: 1 });
  const page = paging.key === filterKey ? paging.page : 1;
  const setPage = (fn) => setPaging({ key: filterKey, page: fn(page) });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api(`/api/ads/campaign-leads?${params(range, filters, { page, limit: PAGE_SIZE })}`)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setError('');
      })
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [filterKey, page]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }));
  const active = Object.values(filters).some(Boolean);

  async function exportCsv(kind) {
    setExporting(kind);
    try {
      const extra = kind === 'wati' ? { kind, chunk } : { kind };
      await download(`/api/ads/campaign-leads/export?${params(range, filters, extra)}`, `campaign-leads.${kind === 'wati' ? 'zip' : 'csv'}`);
      if (kind === 'wati') setWatiOpen(false);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting('');
    }
  }

  const o = (data && data.options) || {};
  const rows = (data && data.data) || [];
  const matched = data ? data.matched : 0;
  const pages = Math.max(1, Math.ceil(matched / PAGE_SIZE));

  return (
    <Section
      title="Campaign leads"
      meta={
        data
          ? `${formatCount(matched)} of ${formatCount(data.total)} Bigin lead(s) created in range`
          : 'Bigin leads by campaign'
      }
      actions={
        <>
          <button onClick={() => exportCsv('full')} disabled={!matched || !!exporting} title="Every column, one file">
            {exporting === 'full' ? 'Exporting…' : 'Full CSV'}
          </button>
          <button
            onClick={() => setWatiOpen((v) => !v)}
            disabled={!matched || !!exporting}
            title="Name, CountryCode, Phone — WATI contact-import format, split into files"
          >
            WATI CSV
          </button>
          {watiOpen && (
            <span className="cl-wati">
              <span className="subtle">Per file:</span>
              {['500', '1000'].map((n) => (
                <label key={n}>
                  <input type="radio" name="wati-chunk" value={n} checked={chunk === n} onChange={() => setChunk(n)} /> {n}
                </label>
              ))}
              <button type="submit" onClick={() => exportCsv('wati')} disabled={!!exporting}>
                {exporting === 'wati' ? 'Exporting…' : `Download ZIP (${Math.ceil(matched / Number(chunk))} file${matched > Number(chunk) ? 's' : ''})`}
              </button>
            </span>
          )}
        </>
      }
    >
      <FilterBar className="cl-filters">
        <label>
          Campaign
          <select value={filters.campaign} onChange={set('campaign')}>
            <option value="">All</option>
            <Options items={o.campaigns} noneLabel="No campaign" />
          </select>
        </label>
        <label>
          CA Status
          <select value={filters.caStatus} onChange={set('caStatus')}>
            <option value="">All</option>
            <Options items={o.caStatuses} noneLabel="Not set" />
          </select>
        </label>
        <label>
          Lead Source
          <select value={filters.source} onChange={set('source')}>
            <option value="">All</option>
            <Options items={o.sources} noneLabel="Not set" />
          </select>
        </label>
        <label>
          Outcome
          <select value={filters.outcome} onChange={set('outcome')}>
            <option value="">All</option>
            <Options items={o.outcomes} renderLabel={(x) => OUTCOME[x.value].label} />
          </select>
        </label>
        <label>
          Owner
          <select value={filters.owner} onChange={set('owner')}>
            <option value="">All</option>
            <Options items={o.owners} noneLabel="Unassigned" />
          </select>
        </label>
        <label>
          Search
          <input type="search" placeholder="Name or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        {active && (
          <button
            onClick={() => {
              setSearch('');
              setFilters(EMPTY);
            }}
          >
            Clear
          </button>
        )}
      </FilterBar>

      {error && <div className="error">{error}</div>}

      {data && rows.length === 0 ? (
        <EmptyState title={active ? 'No leads match these filters' : 'No Bigin leads in this range'}>
          {active ? 'Clear a filter or widen the date range.' : 'Try a wider date range.'}
        </EmptyState>
      ) : (
        <DataTable className="mkt-wide">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Campaign</th>
              <th>CA Status</th>
              <th>Lead Source</th>
              <th>Outcome</th>
              <th>Amount</th>
              <th>Owner</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const out = OUTCOME[r.outcome] || OUTCOME.none;
              return (
                <tr key={r.id}>
                  <td>{r.name || '—'}</td>
                  <td>{r.phone || '—'}</td>
                  <td>{r.campaign || <span className="subtle">—</span>}</td>
                  <td>{r.caStatus || <span className="subtle">—</span>}</td>
                  <td>{r.leadSource || <span className="subtle">—</span>}</td>
                  <td>
                    <span className={out.cls} title={r.dealStage || ''}>
                      {out.label}
                    </span>
                  </td>
                  <td>{r.amount ? formatRupeesWhole(r.amount) : '—'}</td>
                  <td>{r.owner || '—'}</td>
                  <td>{r.createdTime ? formatDay(r.createdTime) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}

      {pages > 1 && (
        <div className="deals-pager">
          <button onClick={() => setPage((p) => p - 1)} disabled={page <= 1 || loading}>
            ← Prev
          </button>
          <span className="subtle">
            Page {page} of {pages}
          </span>
          <button onClick={() => setPage((p) => p + 1)} disabled={page >= pages || loading}>
            Next →
          </button>
        </div>
      )}
    </Section>
  );
}
