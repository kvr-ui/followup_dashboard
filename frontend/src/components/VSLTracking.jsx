import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import DateRangeBar from './DateRangeBar';
import CopyButton from './CopyButton';
import { defaultRange, formatCount, sortRows } from '../adStats';
import { formatDateTime } from '../utils';
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

export default function VSLTracking({ isAdmin, onOpenTask }) {
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

  return (
    <>
      <div className="mkt-head">
        <h2>VSL Tracking</h2>
        <DateRangeBar range={range} onChange={setRange}>
          <button onClick={() => load(range)} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </DateRangeBar>
      </div>

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
          <div className="summary-grid">
            <div className="card clickable" onClick={() => focus('sent')}>
              <div className="num">{formatCount(totals.sent || 0)}</div>
              <div className="label">Links sent</div>
            </div>
            <div className="card clickable" onClick={() => focus('opened')}>
              <div className="num">{formatCount(totals.opened || 0)}</div>
              <div className="label">Opened the page</div>
            </div>
            <div className="card clickable" onClick={() => focus('played')}>
              <div className="num">{formatCount(totals.played || 0)}</div>
              <div className="label">Pressed play</div>
            </div>
            <div className="card clickable" onClick={() => focus('watched')}>
              <div className="num">{formatCount(totals.watched || 0)}</div>
              <div className="label">Watched (10%+)</div>
            </div>
            <div className="card">
              <div className="num">{formatCount(Math.round(totals.minutesTotal || 0))}</div>
              <div className="label">Total minutes watched</div>
            </div>
            {isAdmin && (
              <div className="card clickable" onClick={() => focus('all', 'unlinked')}>
                <div className="num">{formatCount(totals.notInDashboard || 0)}</div>
                <div className="label">Not in the dashboard</div>
              </div>
            )}
          </div>

          <div className="mkt-filters">
            <label>
              <span>Engagement</span>
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
              <span>Lead source</span>
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
                <span>Follow-up</span>
                <select value={link} onChange={(e) => setLink(e.target.value)}>
                  <option value="all">All</option>
                  <option value="linked">In the dashboard</option>
                  <option value="unlinked">Not in the dashboard</option>
                </select>
              </label>
            )}

            {isAdmin && owners.length > 0 && (
              <label>
                <span>Owner</span>
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
              <span>Search</span>
              <input
                type="search"
                value={search}
                placeholder="name or number"
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </div>

          <div className="toolbar">
            <p id="status">
              Showing {rows.length} of {flat.length} VSL lead(s) ·{' '}
              {Math.round(totals.minutesTotal || 0)} minutes watched in total
            </p>
          </div>

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
            <p className="subtle">No VSL leads match the current filters.</p>
          ) : (
            <div className="mkt-scroll">
              <table className="tasks mkt-table">
                <thead>
                  <tr>
                    <th>Lead</th>
                    <th>Mobile</th>
                    <th>Lead source</th>
                    <th className="clickable-row" onClick={() => toggleSort('watchSeconds')}>
                      Minutes watched{sortArrow('watchSeconds')}
                    </th>
                    <th>Engagement</th>
                    <th className="clickable-row" onClick={() => toggleSort('lastActivityAt')}>
                      Last activity{sortArrow('lastActivityAt')}
                    </th>
                    <th>Follow-up</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((lead) => (
                    <Row key={lead.leadId} lead={lead} onOpenTask={onOpenTask} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}

function Row({ lead, onOpenTask }) {
  const watch = lead.watch || {};
  const src = lead.leadSource || {};
  const contact = lead.dashboard?.contactName;
  // Both names are shown when they differ: the VSL takes whatever the lead typed
  // on the page, Bigin holds what the rep recorded, and a mismatch is the sort of
  // thing worth noticing before dialling.
  const secondary = contact && lead.name && contact !== lead.name ? lead.name : null;

  return (
    <tr>
      <td>
        <div className="contact-name">{contact || lead.name || '—'}</div>
        {secondary && <div className="subtle">VSL: {secondary}</div>}
      </td>
      <td>
        {lead.phone ? (
          <span className="phone-row">
            <a className="phone-link" href={`tel:${lead.phone}`}>
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
        {lead.dashboard ? (
          <button className="mkt-open" onClick={() => onOpenTask?.(lead.dashboard.taskId)}>
            {lead.dashboard.ownerName || 'Open follow-up'}
          </button>
        ) : (
          <span className="subtle">not in dashboard</span>
        )}
      </td>
    </tr>
  );
}
