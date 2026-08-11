import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import DateRangeBar from './DateRangeBar';
import {
  LEAD_STATES,
  LEAD_STATUS,
  RESOLVED_BY,
  defaultRange,
  formatCount,
  isTriagedNoCampaign,
  matchHint,
  needsTriage,
  statusState,
} from '../adStats';
import { statusClass } from '../utils';

// The Ad Leads tab — every captured web and Meta lead in one list, carrying the
// three facts the tab exists to answer: which campaign it came from, whether
// anybody is following it up, and whether it ended in a sale.
//
// Both worklist filters are worklists, not curiosities. "Unlinked" is the leads
// nobody is working. "Needs triage" is the ad URLs that are tagged wrong.
//
// WHY THE FILTERING IS CLIENT-SIDE
// --------------------------------
// The endpoint can serve each of these directly — `unlinked`, `unresolved` and
// `unmapped` are all real params, and `unresolved` correctly excludes leads an
// admin already triaged. We fetch the range once, unfiltered, and filter here
// anyway, for two reasons the server cannot give us: the four counts in the
// header are then exact rather than one request each, and switching a filter is
// instant instead of a round trip. The endpoint caps a page at 1,000; past that
// the header says so rather than quietly under-counting.
const PAGE_LIMIT = 1000;

const LINK_FILTERS = {
  all: () => true,
  unlinked: (l) => !l.linked,
  linked: (l) => l.linked,
};

const RESOLUTION_FILTERS = {
  all: () => true,
  resolved: (l) => Boolean(l.campaignId),
  untriaged: needsTriage,
  triaged: isTriagedNoCampaign,
};

// The endpoint takes `?status=` too, but this tab filters the fetched range in
// the browser for the reason given above — so the funnel counts in the header
// stay exact and switching between them costs nothing.
const STATUS_FILTERS = {
  all: () => true,
  ...Object.fromEntries(LEAD_STATES.map((s) => [s, (l) => statusState(l) === s])),
};

const dash = (value) => (value == null || value === '' ? '—' : value);

export default function AdLeads({ onOpenTask }) {
  const [range, setRange] = useState(defaultRange);
  const [leads, setLeads] = useState(null);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [source, setSource] = useState('all');
  const [link, setLink] = useState('all');
  const [resolution, setResolution] = useState('all');
  const [status, setStatus] = useState('all');

  const load = useCallback(async (r) => {
    setLoading(true);
    try {
      const json = await api(`/api/ads/leads?from=${r.from}&to=${r.to}&limit=${PAGE_LIMIT}`);
      setLeads(json.data || []);
      setMeta({ totals: json.totals, truncated: json.truncated });
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(range);
  }, [load, range]);

  const counts = useMemo(() => {
    const all = leads || [];
    const byState = (s) => all.filter((l) => statusState(l) === s).length;
    return {
      all: all.length,
      web: all.filter((l) => l.source === 'web').length,
      meta: all.filter((l) => l.source === 'meta').length,
      unlinked: all.filter((l) => !l.linked).length,
      untriaged: all.filter(needsTriage).length,
      triaged: all.filter(isTriagedNoCampaign).length,
      won: byState('won'),
      lost: byState('lost'),
      pipeline: byState('pipeline'),
      followup: byState('followup'),
      none: byState('none'),
    };
  }, [leads]);

  const rows = useMemo(() => {
    let out = leads || [];
    if (source !== 'all') out = out.filter((l) => l.source === source);
    out = out.filter(LINK_FILTERS[link]);
    out = out.filter(RESOLUTION_FILTERS[resolution]);
    out = out.filter(STATUS_FILTERS[status]);
    return out;
  }, [leads, source, link, resolution, status]);

  // Every card is a shortcut into one combination of the three filters, so it
  // sets all of them — clicking "Closed with sale" while "Not linked" is still
  // selected would otherwise hand back an empty table.
  function focus(nextLink, nextResolution, nextStatus = 'all') {
    setSource('all');
    setLink(nextLink);
    setResolution(nextResolution);
    setStatus(nextStatus);
  }

  return (
    <>
      <div className="mkt-head">
        <h2>Ad Leads</h2>
        <DateRangeBar range={range} onChange={setRange}>
          <button onClick={() => load(range)} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </DateRangeBar>
      </div>

      {error && <div className="error">{error}</div>}
      {!leads && !error && <p className="subtle">Loading ad leads…</p>}

      {leads && (
        <>
          <div className="summary-grid">
            <div className="card clickable" onClick={() => focus('all', 'all')}>
              <div className="num">{formatCount(counts.all)}</div>
              <div className="label">Captured leads</div>
            </div>
            <div className="card clickable" onClick={() => focus('unlinked', 'all')}>
              <div className="num">{formatCount(counts.unlinked)}</div>
              <div className="label">Not linked to a follow-up</div>
            </div>
            <div className="card clickable" onClick={() => focus('all', 'all', 'won')}>
              <div className="num">{formatCount(counts.won)}</div>
              <div className="label">Closed with sale</div>
            </div>
            <div className="card clickable" onClick={() => focus('all', 'all', 'lost')}>
              <div className="num">{formatCount(counts.lost)}</div>
              <div className="label">Closed without sale</div>
            </div>
            <div className="card clickable" onClick={() => focus('all', 'untriaged')}>
              <div className="num">{formatCount(counts.untriaged)}</div>
              <div className="label">UTM resolved to nothing</div>
            </div>
            <div className="card clickable" onClick={() => focus('all', 'triaged')}>
              <div className="num">{formatCount(counts.triaged)}</div>
              <div className="label">Triaged: no Meta campaign</div>
            </div>
          </div>

          <div className="mkt-filters">
            <label>
              <span>Source</span>
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="all">All ({counts.all})</option>
                <option value="web">Web form ({counts.web})</option>
                <option value="meta">Meta instant form ({counts.meta})</option>
              </select>
            </label>
            <label>
              <span>Follow-up</span>
              <select value={link} onChange={(e) => setLink(e.target.value)}>
                <option value="all">All</option>
                <option value="unlinked">Not linked</option>
                <option value="linked">Linked</option>
              </select>
            </label>
            <label>
              <span>Campaign</span>
              <select value={resolution} onChange={(e) => setResolution(e.target.value)}>
                <option value="all">All</option>
                <option value="resolved">Resolved to a campaign</option>
                <option value="untriaged">UTM resolved to nothing</option>
                <option value="triaged">Triaged: no Meta campaign</option>
              </select>
            </label>
            <label>
              <span>Status</span>
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="all">All</option>
                {LEAD_STATES.map((s) => (
                  <option key={s} value={s}>
                    {LEAD_STATUS[s].label} ({counts[s]})
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="toolbar">
            <p id="status">
              Showing {formatCount(rows.length)} of {formatCount(counts.all)} lead(s) ·{' '}
              {formatCount(counts.web)} web, {formatCount(counts.meta)} Meta
            </p>
          </div>

          {meta && meta.truncated && (
            <p className="hint">
              This range holds more than {formatCount(PAGE_LIMIT)} leads
              {meta.totals ? ` (${formatCount(meta.totals.all)} in total)` : ''}. Only the newest{' '}
              {formatCount(PAGE_LIMIT)} are shown — narrow the date range for a complete count.
            </p>
          )}

          {rows.length === 0 ? (
            <p className="subtle">No leads match the current filters.</p>
          ) : (
            <div className="mkt-scroll">
              <table className="tasks mkt-table">
                <thead>
                  <tr>
                    <th>Contact</th>
                    <th>Captured</th>
                    <th>Source</th>
                    <th>UTM</th>
                    <th>Campaign</th>
                    <th>Status</th>
                    <th>Follow-up</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((lead) => (
                    <LeadRow key={`${lead.source}-${lead.id}`} lead={lead} onOpenTask={onOpenTask} />
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

function LeadRow({ lead, onOpenTask }) {
  const utm = lead.utm;
  const how = lead.resolvedBy ? RESOLVED_BY[lead.resolvedBy] : null;
  // A web lead can arrive with the UTM object present but every field empty —
  // somebody reached the form from an untagged link. That is a different problem
  // from a tag that failed to match a campaign, so it does not render as five
  // dashes pretending tags were read.
  const tagged = Boolean(utm) && Object.values(utm).some((v) => v != null && v !== '');

  return (
    <tr>
      <td>
        <div className="contact-name">{dash(lead.name)}</div>
        <div className="subtle">{dash(lead.phone)}</div>
        <div className="subtle">{dash(lead.email)}</div>
      </td>
      <td className="subtle">{lead.capturedAt ? new Date(lead.capturedAt).toLocaleString() : '—'}</td>
      <td>
        <span className="badge badge-normal">{lead.source}</span>
        <div className="subtle">{dash(lead.form)}</div>
      </td>
      <td>
        {utm && !tagged ? (
          <span className="subtle">no UTM tags on the link</span>
        ) : utm ? (
          <div className="mkt-utm">
            <div>
              <b>source</b> {dash(utm.source)}
            </div>
            <div>
              <b>medium</b> {dash(utm.medium)}
            </div>
            <div>
              <b>campaign</b> {dash(utm.campaign)}
            </div>
            {utm.content && (
              <div>
                <b>content</b> {utm.content}
              </div>
            )}
            {utm.term && (
              <div>
                <b>term</b> {utm.term}
              </div>
            )}
          </div>
        ) : (
          // A Meta instant-form lead never passed through a landing page, so
          // there is no UTM to show and its absence is not a tagging fault.
          <span className="subtle">no landing page</span>
        )}
      </td>
      <td>
        {lead.campaignId ? (
          <>
            <div>{lead.campaignName || lead.campaignId}</div>
            {how && (
              <span className="mkt-how" title={how.hint}>
                {how.label}
              </span>
            )}
          </>
        ) : lead.resolvedBy === 'unmapped' ? (
          <span className="mkt-how" title={RESOLVED_BY.unmapped.hint}>
            {RESOLVED_BY.unmapped.label}
          </span>
        ) : (
          <span className="badge badge-high">unresolved</span>
        )}
      </td>
      <td>
        <LeadStatus lead={lead} />
      </td>
      <td>
        {lead.linked && lead.task ? (
          <button className="mkt-open" onClick={() => onOpenTask && onOpenTask(lead.task.id)}>
            Open follow-up
          </button>
        ) : (
          <span className="subtle">not linked</span>
        )}
      </td>
    </tr>
  );
}

// The badge says what happened; the line under it says on what evidence. A won or
// lost badge is backed by the Bigin deal STAGE verbatim rather than our label for
// it, so a stage renamed in Bigin shows up here as itself instead of being
// silently folded into "closed". With no deal, the follow-up task's own Status
// stands in — that is all we know.
function LeadStatus({ lead }) {
  const state = statusState(lead);
  const status = lead.status || {};
  const detail = status.stage || status.taskStatus || null;
  const hint = matchHint(lead);

  return (
    <>
      <span className={statusClass(state)} title={hint || LEAD_STATUS[state].hint}>
        {LEAD_STATUS[state].label}
      </span>
      {detail && <div className="subtle">{detail}</div>}
      {hint && status.matchedBy === 'phone' && <div className="subtle">by phone</div>}
    </>
  );
}
