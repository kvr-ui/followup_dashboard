import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { formatDateTime } from '../utils';
import { money, pct, relative, STATUS_BADGE } from '../campaigns';
import CampaignComposer from './CampaignComposer';
import CampaignDetail from './CampaignDetail';
import Segments from './Segments';
import CampaignHealth from './CampaignHealth';
import CampaignInbox from './CampaignInbox';

/**
 * The campaigns view. Four sub-tabs, following the Won/Lost pattern in Calls.jsx.
 *
 * The summary row deliberately leads with CLICKS, not reads. Read counts are the
 * number everyone wants to look at and the number that lies to you — WhatsApp only
 * reports a read if the contact has blue ticks switched on, and plenty don't. Clicks
 * are the only unambiguous signal in the whole product, so they get the green.
 */
export default function Campaigns() {
  const [tab, setTab] = useState('campaigns');
  const [res, setRes] = useState(null);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const q = status ? `?status=${encodeURIComponent(status)}` : '';
      setRes(await api(`/api/campaigns${q}`));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    if (tab !== 'campaigns') return undefined;
    load();
    // A sending campaign moves while you watch it, so this view polls. The others
    // don't — nothing on them changes second to second.
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [tab, load]);

  const rows = useMemo(() => res?.data || [], [res]);

  const shown = useMemo(() => {
    const q = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!q) return rows;
    const rx = new RegExp(q, 'i');
    return rows.filter((r) => rx.test(r.name) || rx.test(r.templateName || ''));
  }, [rows, search]);

  const totals = res?.totals || {};
  const rates = res?.rates || {};

  if (tab !== 'campaigns') {
    return (
      <>
        <SubTabs tab={tab} setTab={setTab} sending={res?.sending || 0} />
        {tab === 'segments' && <Segments />}
        {tab === 'inbox' && <CampaignInbox />}
        {tab === 'health' && <CampaignHealth />}
      </>
    );
  }

  return (
    <>
      <SubTabs tab={tab} setTab={setTab} sending={res?.sending || 0} />

      <div className="summary-grid">
        <div className="card">
          <div className="num">{totals.sent || 0}</div>
          <div className="label">Sent</div>
        </div>
        <div className="card">
          <div className="num">{totals.delivered || 0}</div>
          <div className="label">Delivered · {pct(rates.deliveryRate)}</div>
        </div>
        <div className="card today">
          <div className="num">{totals.read || 0}</div>
          <div className="label">Read · {pct(rates.readRate)}</div>
        </div>
        <div className="card">
          <div className="num" style={{ color: 'var(--green)' }}>
            {totals.clicked || 0}
          </div>
          <div className="label">Clicked · {pct(rates.clickRate)}</div>
        </div>
        <div className="card">
          <div className="num" style={{ color: 'var(--green)' }}>
            {totals.replied || 0}
          </div>
          <div className="label">Replied · {pct(rates.replyRate)}</div>
        </div>
        <div className="card">
          <div className="num">{money(totals.cost)}</div>
          <div className="label">Spend</div>
        </div>
      </div>

      <div className="filters">
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="draft">Draft</option>
            <option value="scheduled">Scheduled</option>
            <option value="sending">Sending</option>
            <option value="paused">Paused</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <label>
          Search
          <input
            type="text"
            placeholder="Campaign or template"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <button onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <button type="submit" onClick={() => setCreating(true)}>
          New campaign
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <p id="status">
        {rows.length === 0
          ? 'No campaigns yet.'
          : `${shown.length} campaign(s)` +
            (res.sending ? ` — ${res.sending} sending right now` : '')}
      </p>

      <div className="card" style={{ padding: '16px 18px' }}>
        <table className="tasks">
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Status</th>
              <th>Template</th>
              <th style={{ textAlign: 'right' }}>Audience</th>
              <th style={{ textAlign: 'right' }}>Sent</th>
              <th style={{ textAlign: 'right' }}>Delivered</th>
              <th style={{ textAlign: 'right' }}>Read</th>
              <th style={{ textAlign: 'right' }}>Clicked</th>
              <th style={{ textAlign: 'right' }}>Replied</th>
              <th style={{ textAlign: 'right' }}>Cost</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <tr
                key={c.id}
                className="clickable-row"
                onClick={() => setSelectedId(c.id)}
              >
                <td>
                  <div className="contact-name">{c.name}</div>
                  {c.parentState && (
                    <div className="subtle" style={{ fontSize: '0.75rem' }}>
                      retarget · {c.parentState.replace(/_/g, ' ')}
                    </div>
                  )}
                </td>
                <td>
                  <span className={STATUS_BADGE[c.status] || 'badge badge-normal'}>
                    {c.status}
                  </span>
                </td>
                <td className="subtle">{c.templateName}</td>
                <td style={{ textAlign: 'right' }}>{c.stats.audienceSize || 0}</td>
                <td style={{ textAlign: 'right' }}>{c.stats.sent || 0}</td>
                <td style={{ textAlign: 'right' }}>
                  {c.stats.delivered || 0}
                  <span className="subtle"> · {pct(c.rates.deliveryRate)}</span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  {c.stats.read || 0}
                  <span className="subtle"> · {pct(c.rates.readRate)}</span>
                </td>
                <td
                  style={{
                    textAlign: 'right',
                    fontWeight: 600,
                    color: c.stats.clicked ? 'var(--green)' : 'inherit',
                  }}
                >
                  {c.stats.clicked || 0}
                  <span className="subtle" style={{ fontWeight: 400 }}>
                    {' '}
                    · {pct(c.rates.clickRate)}
                  </span>
                </td>
                <td
                  style={{
                    textAlign: 'right',
                    fontWeight: 600,
                    color: c.stats.replied ? 'var(--green)' : 'inherit',
                  }}
                >
                  {c.stats.replied || 0}
                </td>
                <td style={{ textAlign: 'right' }}>{money(c.actualCost, c.currency)}</td>
                <td className="subtle" title={formatDateTime(c.createdAt)}>
                  {relative(c.createdAt)}
                </td>
              </tr>
            ))}

            {shown.length === 0 && !loading && (
              <tr>
                <td colSpan={11} className="subtle">
                  {rows.length === 0
                    ? 'No campaigns yet. Add some contacts, then create a campaign — it starts as a draft, so nothing sends until you say so.'
                    : 'No campaigns match your search.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="subtle" style={{ marginTop: 12 }}>
          Delivery is a share of what was sent; read, click and reply are shares of what
          was <em>delivered</em> — a message that never arrived cannot be read, and
          counting it would blame your copy for a dead phone number. Read counts are a
          floor, not a truth: WhatsApp only reports a read when the contact has read
          receipts switched on. Trust the click column.
        </div>
      </div>

      {creating && (
        <CampaignComposer
          onClose={() => setCreating(false)}
          onSent={(id, msg) => {
            setCreating(false);
            setNotice(msg || 'Done.');
            load();
            setSelectedId(id);
          }}
        />
      )}

      {selectedId && (
        <CampaignDetail
          campaignId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={load}
          onOpenCampaign={setSelectedId}
        />
      )}
    </>
  );
}

function SubTabs({ tab, setTab, sending }) {
  const t = (key, label) => (
    <button
      className={tab === key ? 'tab active' : 'tab'}
      onClick={() => setTab(key)}
    >
      {label}
    </button>
  );

  return (
    <nav className="tabs" style={{ width: 'fit-content', marginBottom: 18 }}>
      {t('campaigns', sending ? `Campaigns (${sending} sending)` : 'Campaigns')}
      {t('segments', 'Audiences')}
      {t('inbox', 'Replies')}
      {t('health', 'Number health')}
    </nav>
  );
}
