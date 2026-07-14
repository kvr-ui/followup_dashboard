import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { formatDateTime } from '../utils';
import { relative } from '../campaigns';
import CopyButton from './CopyButton';

/**
 * Everyone who wrote back.
 *
 * The column that matters most here is the last one: whether WhatsApp's 24-hour
 * window is still open. Inside it, a rep can just type a reply. Outside it, they can
 * only send a pre-approved template — which costs money and reads like a robot. A rep
 * who doesn't know which side of that line they're on will sit on a hot lead until
 * the window closes.
 */
export default function CampaignInbox() {
  const [res, setRes] = useState(null);
  const [search, setSearch] = useState('');
  const [openOnly, setOpenOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setRes(await api('/api/campaigns/inbox'));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => res?.data || [], [res]);

  const shown = useMemo(() => {
    let out = rows;
    if (openOnly) out = out.filter((r) => r.sessionOpen);
    const q = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (q) {
      const rx = new RegExp(q, 'i');
      out = out.filter(
        (r) => rx.test(r.name || '') || rx.test(r.phone) || rx.test(r.replyText || '')
      );
    }
    return out;
  }, [rows, search, openOnly]);

  return (
    <>
      <div className="summary-grid">
        <div className="card">
          <div className="num">{res?.count ?? 0}</div>
          <div className="label">Replies</div>
        </div>
        <div className="card">
          <div className="num" style={{ color: 'var(--green)' }}>
            {res?.sessionOpen ?? 0}
          </div>
          <div className="label">Still answerable free</div>
        </div>
      </div>

      <div className="filters">
        <label>
          Search
          <input
            type="text"
            placeholder="Name, number or message"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={openOnly}
            style={{ width: 'auto' }}
            onChange={(e) => setOpenOnly(e.target.checked)}
          />
          Only the ones we can still reply to free
        </label>
        <button onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      <p id="status">
        {rows.length === 0
          ? 'Nobody has replied to a campaign yet.'
          : `${shown.length} of ${rows.length} reply(s)`}
      </p>

      <div className="card" style={{ padding: '16px 18px' }}>
        <table className="tasks">
          <thead>
            <tr>
              <th>Contact</th>
              <th>Campaign</th>
              <th>What they said</th>
              <th>When</th>
              <th>Reply window</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                <td>
                  <div className="contact-name">{r.name || '—'}</div>
                  <div className="phone-row">
                    <span className="subtle">{r.phone}</span>
                    <CopyButton text={r.phone} title="Copy phone number" />
                  </div>
                  {r.clicked && (
                    <span className="badge badge-low" style={{ marginTop: 4 }}>
                      clicked the link
                    </span>
                  )}
                </td>
                <td className="subtle">{r.campaign || '—'}</td>
                <td>{r.replyText || <span className="subtle">(no text)</span>}</td>
                <td className="subtle" title={formatDateTime(r.repliedAt)}>
                  {relative(r.repliedAt)}
                </td>
                <td>
                  {r.sessionOpen ? (
                    <span style={{ color: 'var(--green)', fontWeight: 600 }}>
                      Open
                      <div className="subtle" style={{ fontWeight: 400 }}>
                        free until {formatDateTime(r.sessionExpiresAt)}
                      </div>
                    </span>
                  ) : (
                    <span className="subtle">
                      Closed
                      <div style={{ fontSize: '0.72rem' }}>template only — costs money</div>
                    </span>
                  )}
                </td>
              </tr>
            ))}

            {shown.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="subtle">
                  {rows.length === 0
                    ? 'No replies yet. Replies show up here the moment WATI posts them to the webhook.'
                    : 'No replies match your search.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="subtle" style={{ marginTop: 12 }}>
          WhatsApp lets you send free-text for 24 hours after the contact's last message.
          After that it has to be a paid, pre-approved template. Answer the open ones
          first — they are both cheaper and warmer.
        </div>
      </div>
    </>
  );
}
