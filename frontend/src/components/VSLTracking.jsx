import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import DateRangeBar from './DateRangeBar';
import CopyButton from './CopyButton';
import PageHeader from './ui/PageHeader';
import FilterBar from './ui/FilterBar';
import DataTable from './ui/DataTable';
import StatCard, { StatGrid } from './ui/StatCard';
import EmptyState from './ui/EmptyState';
import Icon from './ui/Icon';
import { defaultRange, formatCount, sortRows } from '../adStats';
import { formatDateTime } from '../utils';
import { openLead, rowPhoneKey } from '../route';
import {
  ENGAGEMENT,
  ENGAGEMENT_FILTERS,
  ENGAGEMENT_STATES,
  LINK_FILTERS,
  clampPct,
  engagementClass,
  formatWatch,
} from '../vslStats';

// The VSL Tracking tab — who was sent the video, who opened it, and how many
// minutes they actually watched, next to the name, number and lead source you'd
// need to act on it.
//
// WHERE THE MINUTES COME FROM
// ---------------------------
// The PEAK ever recorded in the VSL's event log, not the value on its lead
// record: that one is overwritten on every beacon, so it falls when somebody
// reopens the video. The server does that fold — see modules/vsl/services/
// watchIndex.js — and stamps `watch.basis` so a figure it had to infer never
// passes as one it measured.
//
// WHY THE FILTERING IS CLIENT-SIDE
// --------------------------------
// Same reasoning as the Ad Leads tab: the endpoint takes `engagement`, `linked`
// and `search` and applies them properly, but we fetch the range once and filter
// here so the funnel counts in the header stay exact rather than costing a
// request each, and switching a filter is instant. The endpoint caps a page at
// 1,000; past that the header says so rather than quietly under-counting.
const PAGE_LIMIT = 1000;

const dash = <span className="subtle">—</span>;

export default function VSLTracking({ isAdmin }) {
  const [range, setRange] = useState(defaultRange);
  const [res, setRes] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [engagement, setEngagement] = useState('all');
  const [link, setLink] = useState('all');
  const [source, setSource] = useState('all');
  const [owner, setOwner] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: 'watchSeconds', dir: 'desc' });

  const load = useCallback(
    async (r) => {
      setLoading(true);
      try {
        // Non-admins are scoped server-side, so never send an owner for them.
        const ownerQ = isAdmin && owner ? `&owner=${encodeURIComponent(owner)}` : '';
        const json = await api(`/api/vsl/leads?from=${r.from}&to=${r.to}&limit=${PAGE_LIMIT}${ownerQ}`);
        setRes(json);
        setError('');
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    [isAdmin, owner]
  );

  useEffect(() => {
    load(range);
  }, [load, range]);

  const leads = useMemo(() => res?.data || [], [res]);
  const totals = res?.totals || {};

  // Flattened once so the sorter and the filters read plain fields rather than
  // reaching through `watch` on every comparison.
  const flat = useMemo(
    () =>
      leads.map((l) => ({
        ...l,
        watchSeconds: l.watch?.seconds || 0,
        watchPercentage: l.watch?.percentage || 0,
        sourceKey: l.leadSource?.key || null,
        contactName: l.dashboard?.contactName || l.name || null,
      })),
    [leads]
  );

  // Built from the rows themselves: only sources and owners actually present are
  // worth offering, the same way Installments builds its owner dropdown.
  const sources = useMemo(() => {
    const set = new Set();
    flat.forEach((l) => l.sourceKey && set.add(l.sourceKey));
    return [...set].sort();
  }, [flat]);

  const owners = useMemo(() => {
    const m = new Map();
    flat.forEach((l) => {
      const email = l.dashboard?.ownerEmail;
      if (email) m.set(email, l.dashboard.ownerName || email);
    });
    return [...m.entries()].map(([email, name]) => ({ email, name }));
  }, [flat]);

  const rows = useMemo(() => {
    let out = flat.filter(ENGAGEMENT_FILTERS[engagement] || ENGAGEMENT_FILTERS.all);
    out = out.filter(LINK_FILTERS[link] || LINK_FILTERS.all);
    if (source !== 'all') out = out.filter((l) => l.sourceKey === source);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter(
        (l) =>
          (l.name || '').toLowerCase().includes(q) ||
          (l.phone || '').includes(q) ||
          (l.contactName || '').toLowerCase().includes(q)
      );
    }
    return sortRows(out, sort.key, sort.dir);
  }, [flat, engagement, link, source, search, sort]);

  // Every card is a shortcut into one combination of filters, so it resets all of
  // them — clicking "Watched" while "Not in dashboard" is still selected would
  // otherwise hand back an empty table.
  function focus(nextEngagement, nextLink = 'all') {
    setEngagement(nextEngagement);
    setLink(nextLink);
    setSource('all');
    setSearch('');
  }

  function toggleSort(key) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));
  }

  const sortArrow = (key) => (sort.key === key ? (sort.dir === 'desc' ? ' ▾' : ' ▴') : '');

  // A card reads as selected when the filters are exactly the combination it sets.
  const isFocus = (e, l = 'all') =>
    engagement === e && link === l && source === 'all' && !search;

  return (
    <>
      <PageHeader
        actions={
          <DateRangeBar range={range} onChange={setRange}>
            <button onClick={() => load(range)} disabled={loading}>
              <Icon name="refresh" size={14} />
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </DateRangeBar>
        }
      />

      {error && <div className="error">{error}</div>}

      {/* Not configured is not a failure: the dashboard runs fine without a VSL
          cluster, so say what is missing rather than showing an error banner. */}
      {res && res.configured === false && (
        <div className="hint">
          VSL watch tracking is not switched on for this server. Set{' '}
          <code>VSL_MONGO_URI</code> in the backend environment to point at the VSL
          project&apos;s database, then restart.
        </div>
      )}

      {!res && !error && <p className="subtle">Loading VSL watch data…</p>}

      {res && res.configured !== false && (
        <>
          <StatGrid>
            <StatCard
              label="Links sent"
              value={formatCount(totals.sent || 0)}
              active={isFocus('sent')}
              onClick={() => focus('sent')}
            />
            <StatCard
              label="Opened the page"
              value={formatCount(totals.opened || 0)}
              active={isFocus('opened')}
              onClick={() => focus('opened')}
            />
            <StatCard
              label="Pressed play"
              value={formatCount(totals.played || 0)}
              active={isFocus('played')}
              onClick={() => focus('played')}
            />
            <StatCard
              label="Watched (10%+)"
              value={formatCount(totals.watched || 0)}
              active={isFocus('watched')}
              onClick={() => focus('watched')}
            />
            <StatCard
              label="Total minutes watched"
              value={formatCount(Math.round(totals.minutesTotal || 0))}
            />
            {isAdmin && (
              <StatCard
                label="Not in the dashboard"
                value={formatCount(totals.notInDashboard || 0)}
                active={isFocus('all', 'unlinked')}
                onClick={() => focus('all', 'unlinked')}
              />
            )}
          </StatGrid>

          <FilterBar>
            <label>
              Engagement
              <select value={engagement} onChange={(e) => setEngagement(e.target.value)}>
                <option value="all">All</option>
                {ENGAGEMENT_STATES.map((s) => (
                  <option key={s} value={s}>
                    {ENGAGEMENT[s].label}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Lead source
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="all">All</option>
                {sources.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>

            {isAdmin && (
              <label>
                Follow-up
                <select value={link} onChange={(e) => setLink(e.target.value)}>
                  <option value="all">All</option>
                  <option value="linked">In the dashboard</option>
                  <option value="unlinked">Not in the dashboard</option>
                </select>
              </label>
            )}

            {isAdmin && owners.length > 0 && (
              <label>
                Owner
                <select value={owner} onChange={(e) => setOwner(e.target.value)}>
                  <option value="">Everyone</option>
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
                type="search"
                value={search}
                placeholder="name or number"
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </FilterBar>

          <PageHeader
            meta={
              <span id="status">
                Showing {rows.length} of {flat.length} VSL lead(s) ·{' '}
                {Math.round(totals.minutesTotal || 0)} minutes watched in total
              </span>
            }
          />

          {res.truncated && (
            <p className="hint">
              Showing the first {PAGE_LIMIT} leads in this range. Narrow the dates to
              see the rest.
            </p>
          )}

          {/* Counted, not hidden: a number too short to match a follow-up is a data
              problem somebody should be able to see. */}
          {isAdmin && totals.unjoinable > 0 && (
            <p className="hint">
              {totals.unjoinable} lead(s) have a phone number too short to match a
              follow-up, so they can never link to one.
            </p>
          )}

          {rows.length === 0 ? (
            <EmptyState title="No VSL leads match the current filters" />
          ) : (
            <DataTable className="mkt-wide">
              <thead>
                <tr>
                  <th>Lead</th>
                  <th>Mobile</th>
                  <th>Lead source</th>
                  <th className="mkt-sortable" onClick={() => toggleSort('watchSeconds')}>
                    Minutes watched{sortArrow('watchSeconds')}
                  </th>
                  <th>Engagement</th>
                  <th className="mkt-sortable" onClick={() => toggleSort('lastActivityAt')}>
                    Last activity{sortArrow('lastActivityAt')}
                  </th>
                  <th>Follow-up</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((lead) => (
                  <Row key={lead.leadId} lead={lead} />
                ))}
              </tbody>
            </DataTable>
          )}
        </>
      )}
    </>
  );
}

function Row({ lead }) {
  const watch = lead.watch || {};
  // The row opens the lead page. A lead with no usable phone has nowhere to go.
  const leadKey = rowPhoneKey(lead, lead.phone);
  const open = (e) => {
    e.stopPropagation();
    openLead(leadKey);
  };
  const src = lead.leadSource || {};
  const contact = lead.dashboard?.contactName;
  // Both names are shown when they differ: the VSL takes whatever the lead typed
  // on the page, Bigin holds what the rep recorded, and a mismatch is the sort of
  // thing worth noticing before dialling.
  const secondary = contact && lead.name && contact !== lead.name ? lead.name : null;

  return (
    <tr className={leadKey ? 'clickable-row' : undefined} onClick={leadKey ? open : undefined}>
      <td>
        <div className="contact-name">{contact || lead.name || '—'}</div>
        {secondary && <div className="subtle">VSL: {secondary}</div>}
      </td>
      <td>
        {lead.phone ? (
          <span className="phone-row">
            <a className="phone-link" href={`tel:${lead.phone}`} onClick={(e) => e.stopPropagation()}>
              {lead.phone}
            </a>
            <CopyButton text={lead.phone} title="Copy phone number" />
          </span>
        ) : (
          dash
        )}
      </td>
      <td>
        {src.key ? (
          <>
            <span className="badge badge-normal">{src.key}</span>
            {/* Task.leadSource is which ad collection the lead was linked to, not
                a channel a rep recorded in Bigin. Say which one answered. */}
            {src.basis === 'task' && (
              <span className="mkt-how" title="Derived from the linked ad lead, not from Bigin's lead source field.">
                from ad lead
              </span>
            )}
          </>
        ) : (
          dash
        )}
      </td>
      <td>
        <div className="vsl-minutes">{formatWatch(watch.seconds, watch.percentage)}</div>
        {/* Only when we know how long the video is. The VSL reports videoDuration
            on well under 1% of events, so for almost every lead there is no
            percentage to draw — and an empty track next to "44.1 min" reads as
            "watched none of it", which is the opposite of the truth. */}
        {watch.seconds > 0 && watch.percentage > 0 && (
          <div className="vsl-bar" title={`${Math.round(watch.percentage)}% of the video`}>
            <div
              className={watch.completed ? 'vsl-bar-fill vsl-bar-done' : 'vsl-bar-fill'}
              style={{ width: `${clampPct(watch.percentage)}%` }}
            />
          </div>
        )}
        {watch.basis === 'lead' && (
          <span className="mkt-how" title="From the lead record, which the VSL overwrites on every event — so it is the last session, not the longest.">
            unverified
          </span>
        )}
      </td>
      <td>
        <span className={engagementClass(lead.engagement)} title={ENGAGEMENT[lead.engagement]?.hint}>
          {ENGAGEMENT[lead.engagement]?.label || lead.engagement}
        </span>
      </td>
      <td className="subtle">{lead.lastActivityAt ? formatDateTime(lead.lastActivityAt) : '—'}</td>
      <td>
        {lead.dashboard && leadKey ? (
          <button className="mkt-open" onClick={open}>
            {lead.dashboard.ownerName || 'Open follow-up'}
          </button>
        ) : (
          <span className="subtle">not in dashboard</span>
        )}
      </td>
    </tr>
  );
}
