import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { formatDateTime } from '../utils';
import { hourLabel, money, pct, relative, STATE_COLOR, STATUS_BADGE } from '../campaigns';
import CopyButton from './CopyButton';
import SequenceForm from './SequenceForm';

/**
 * One campaign, end to end.
 *
 * The funnel is the centre of this page, and every state in it has a Retarget button.
 * That is the entire thesis of the feature: a dashboard that only tells you your read
 * rate is a report, and a report doesn't earn anything. Turning "read it, never
 * clicked" into a new campaign with two clicks is the thing that does.
 */
export default function CampaignDetail({ campaignId, onClose, onChanged, onOpenCampaign }) {
  const [res, setRes] = useState(null);
  const [preview, setPreview] = useState(null);
  const [messages, setMessages] = useState([]);
  const [timing, setTiming] = useState(null);
  const [state, setState] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [scheduleAt, setScheduleAt] = useState('');
  const [drip, setDrip] = useState(false);

  const load = useCallback(async () => {
    try {
      const json = await api(`/api/campaigns/${campaignId}`);
      setRes(json);
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  const loadMessages = useCallback(async () => {
    try {
      const q = state ? `?state=${encodeURIComponent(state)}` : '';
      const json = await api(`/api/campaigns/${campaignId}/messages${q}`);
      setMessages(json.data || []);
    } catch (e) {
      setError(e.message);
    }
  }, [campaignId, state]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  const campaign = res?.data;

  // A sending campaign is a live thing. Poll while it moves, stop when it stops.
  useEffect(() => {
    if (campaign?.status !== 'sending') return undefined;
    const timer = setInterval(() => {
      load();
      loadMessages();
    }, 8000);
    return () => clearInterval(timer);
  }, [campaign?.status, load, loadMessages]);

  useEffect(() => {
    if (!campaign) return;
    if (['draft', 'scheduled'].includes(campaign.status)) {
      api(`/api/campaigns/${campaignId}/preview`, { method: 'POST' })
        .then(setPreview)
        .catch(() => {});
    } else {
      api(`/api/campaigns/${campaignId}/timing`).then(setTiming).catch(() => {});
    }
  }, [campaign?.status, campaignId, campaign]);

  const act = async (path, body, successMsg) => {
    setBusy(path);
    setError('');
    setNotice('');
    try {
      const json = await api(`/api/campaigns/${campaignId}/${path}`, {
        method: 'POST',
        body: body || {},
      });
      setNotice(successMsg || json.message || 'Done.');
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  const retarget = async (stateKey, label) => {
    setBusy(`retarget:${stateKey}`);
    setError('');
    try {
      const json = await api(`/api/campaigns/${campaignId}/retarget`, {
        method: 'POST',
        body: { state: stateKey },
      });
      onChanged?.();
      // Jump straight into the new draft. The whole point is that the next action is
      // obvious — change the message, then send it.
      onOpenCampaign?.(json.data.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  const funnel = useMemo(() => res?.funnel || [], [res]);
  const maxCount = useMemo(
    () => Math.max(1, ...funnel.map((f) => f.count)),
    [funnel]
  );

  if (loading) {
    return (
      <div className="drawer-backdrop" onClick={onClose}>
        <aside className="drawer drawer-wide" onClick={(e) => e.stopPropagation()}>
          <p className="subtle">Loading campaign…</p>
        </aside>
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="drawer-backdrop" onClick={onClose}>
        <aside className="drawer drawer-wide" onClick={(e) => e.stopPropagation()}>
          <div className="error">{error || 'Campaign not found'}</div>
        </aside>
      </div>
    );
  }

  const isDraft = ['draft', 'scheduled'].includes(campaign.status);
  const eff = res.efficiency || {};

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer drawer-wide" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>{campaign.name}</h2>
          <button className="link-danger" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="row-between" style={{ marginBottom: 12 }}>
          <span className={STATUS_BADGE[campaign.status] || 'badge badge-normal'}>
            {campaign.status}
          </span>
          <span className="subtle">
            {campaign.templateName} · {campaign.templateCategory}
            {campaign.scheduledAt && ` · scheduled ${formatDateTime(campaign.scheduledAt)}`}
          </span>
        </div>

        {campaign.description && <p className="subtle">{campaign.description}</p>}

        {error && <div className="error">{error}</div>}
        {notice && <div className="notice">{notice}</div>}
        {campaign.lastError && <div className="error">{campaign.lastError}</div>}

        {/* Lineage — where these people came from. */}
        {campaign.parentCampaignId && (
          <div className="hint">
            Retarget of an earlier campaign, aimed at contacts who were{' '}
            <strong>{(campaign.parentState || '').replace(/_/g, ' ')}</strong>.{' '}
            <button
              className="link-danger"
              style={{ color: 'var(--accent)' }}
              onClick={() => onOpenCampaign?.(campaign.parentCampaignId)}
            >
              Open the parent
            </button>
          </div>
        )}

        {/* ---- DRAFT: preview before you spend money on real people ---- */}
        {isDraft && (
          <section className="drawer-section">
            <h3 style={{ marginTop: 0 }}>Before you send</h3>

            {!preview ? (
              <p className="subtle">Counting the audience…</p>
            ) : (
              <>
                <div className="mini-grid">
                  <div className="panel-sm">
                    <h3>Recipients</h3>
                    <div className="num" style={{ fontSize: '1.6rem' }}>
                      {preview.recipients}
                    </div>
                  </div>
                  <div className="panel-sm">
                    <h3>Excluded</h3>
                    <div className="num" style={{ fontSize: '1.6rem' }}>
                      {preview.excluded}
                    </div>
                    <div className="subtle">opted out or unreachable</div>
                  </div>
                  <div className="panel-sm">
                    <h3>Estimated cost</h3>
                    <div className="num" style={{ fontSize: '1.6rem' }}>
                      {money(preview.estimatedCost, preview.currency)}
                    </div>
                  </div>
                </div>

                {preview.variableAudit?.length > 0 && (
                  <div className="hint" style={{ marginTop: 12 }}>
                    <strong>Some contacts are missing values:</strong>
                    <ul style={{ margin: '6px 0 0 18px' }}>
                      {preview.variableAudit.map((v) => (
                        <li key={v.name}>
                          <code>{`{{${v.name}}}`}</code> is blank for {v.missing} of the
                          sampled contacts
                          {v.hasFallback
                            ? ' — a fallback is set, so they will still read properly.'
                            : ' — with no fallback, they will see a gap in the sentence.'}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {!preview.linkTrackingConfigured && campaign.trackLinks && (
                  <div className="hint" style={{ marginTop: 12 }}>
                    PUBLIC_BASE_URL is not set on the server, so links in this campaign
                    will <strong>not</strong> be tracked. It will still send — you just
                    won't know who clicked, which is the only real intent signal
                    WhatsApp gives you.
                  </div>
                )}

                {preview.renderedSample && (
                  <div style={{ marginTop: 12 }}>
                    <div className="field-label">
                      What {preview.renderedSample.contact} will see
                    </div>
                    <div
                      className="card"
                      style={{ padding: 12, marginTop: 6, background: 'var(--surface-inset)' }}
                    >
                      {Object.entries(preview.renderedSample.variables).map(([k, v]) => (
                        <div key={k} style={{ fontSize: '0.85rem' }}>
                          <span className="subtle">{`{{${k}}}`} → </span>
                          <strong>{v || <em className="subtle">(blank)</em>}</strong>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {preview.sample?.length > 0 && (
                  <div className="subtle" style={{ marginTop: 10 }}>
                    First few: {preview.sample.slice(0, 5).map((s) => s.name || s.phoneKey).join(', ')}
                    {preview.recipients > 5 && ` and ${preview.recipients - 5} more`}
                  </div>
                )}
              </>
            )}

            {campaign.requiresApproval && !campaign.approvedAt && (
              <div className="hint" style={{ marginTop: 12 }}>
                This campaign needs an approval before it can send.{' '}
                <button
                  className="link-danger"
                  style={{ color: 'var(--accent)' }}
                  disabled={busy === 'approve'}
                  onClick={() => act('approve', {}, 'Approved.')}
                >
                  Approve it
                </button>
              </div>
            )}

            <div
              className="row-between"
              style={{ marginTop: 16, gap: 8, flexWrap: 'wrap' }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
                <label>
                  Schedule for
                  <input
                    type="datetime-local"
                    value={scheduleAt}
                    onChange={(e) => setScheduleAt(e.target.value)}
                  />
                </label>
                <button
                  disabled={!scheduleAt || busy === 'schedule'}
                  onClick={() =>
                    act('schedule', { scheduledAt: new Date(scheduleAt).toISOString() })
                  }
                >
                  {busy === 'schedule' ? 'Scheduling…' : 'Schedule'}
                </button>
              </div>

              <button
                type="submit"
                disabled={busy === 'send' || !preview?.recipients}
                onClick={() => {
                  const n = preview?.recipients || 0;
                  if (
                    window.confirm(
                      `Send "${campaign.name}" to ${n} contact(s) on WhatsApp?\n\nThis cannot be undone — a WhatsApp message cannot be recalled.`
                    )
                  ) {
                    act('send', {});
                  }
                }}
              >
                {busy === 'send'
                  ? 'Starting…'
                  : `Send to ${preview?.recipients ?? '…'} now`}
              </button>
            </div>
          </section>
        )}

        {/* ---- LIVE / DONE: the funnel, and the retarget buttons ---- */}
        {!isDraft && (
          <section className="drawer-section">
            <div className="row-between">
              <h3 style={{ marginTop: 0 }}>What happened</h3>
              <span className="subtle">
                {campaign.stats.sent} sent · {money(campaign.actualCost, campaign.currency)} spent
              </span>
            </div>

            {funnel.map((f) => (
              <div key={f.key} style={{ marginBottom: 10 }}>
                <div className="row-between" style={{ alignItems: 'center' }}>
                  <div>
                    <strong style={{ color: STATE_COLOR[f.key] }}>{f.label}</strong>{' '}
                    <span className="subtle">— {f.hint}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="rate-num">{f.count}</span>
                    {f.retargetable && f.count > 0 && (
                      <button
                        disabled={busy === `retarget:${f.key}`}
                        onClick={() => retarget(f.key, f.label)}
                      >
                        {busy === `retarget:${f.key}` ? 'Building…' : 'Retarget'}
                      </button>
                    )}
                    <button
                      className="link-danger"
                      style={{ color: 'var(--accent)' }}
                      onClick={() => setState(state === f.key ? '' : f.key)}
                    >
                      {state === f.key ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </div>
                <div className="rate-wrap">
                  <div className="rate-bar">
                    <span
                      style={{
                        width: `${(f.count / maxCount) * 100}%`,
                        background: STATE_COLOR[f.key],
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}

            <div className="mini-grid" style={{ marginTop: 16 }}>
              <div className="panel-sm">
                <h3>Cost per click</h3>
                <div className="num" style={{ fontSize: '1.4rem' }}>
                  {eff.costPerClick === null ? '—' : money(eff.costPerClick, eff.currency)}
                </div>
              </div>
              <div className="panel-sm">
                <h3>Cost per reply</h3>
                <div className="num" style={{ fontSize: '1.4rem' }}>
                  {eff.costPerReply === null ? '—' : money(eff.costPerReply, eff.currency)}
                </div>
              </div>
              <div className="panel-sm">
                <h3>Click rate</h3>
                <div className="num" style={{ fontSize: '1.4rem', color: 'var(--green)' }}>
                  {pct(campaign.rates.clickRate)}
                </div>
              </div>
              <div className="panel-sm">
                <h3>Read rate</h3>
                <div className="num" style={{ fontSize: '1.4rem' }}>
                  {pct(campaign.rates.readRate)}
                </div>
                <div className="subtle">blue ticks only</div>
              </div>
            </div>
            <div className="subtle" style={{ marginTop: 8 }}>
              A dash means nobody has done that yet — which is not the same as it being
              free.
            </div>
          </section>
        )}

        {/* ---- Best send time ---- */}
        {timing && timing.total > 0 && (
          <section className="drawer-section">
            <h3 style={{ marginTop: 0 }}>When they actually read it</h3>
            <div className="subtle" style={{ marginBottom: 10 }}>
              Reads and clicks by hour, in {timing.timezone}.
              {timing.bestHour !== null && (
                <>
                  {' '}
                  Your audience is most active around{' '}
                  <strong>{hourLabel(timing.bestHour)}</strong> — send the next one then,
                  not when it happens to suit you.
                </>
              )}
            </div>

            <div style={{ display: 'flex', gap: 2, alignItems: 'end', height: 90 }}>
              {timing.data.map((h) => {
                const max = Math.max(...timing.data.map((x) => x.read + x.clicked), 1);
                const total = h.read + h.clicked;
                return (
                  <div
                    key={h.hour}
                    title={`${hourLabel(h.hour)} — ${h.read} read, ${h.clicked} clicked`}
                    style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'end', height: '100%' }}
                  >
                    <div
                      style={{
                        height: `${(h.clicked / max) * 100}%`,
                        background: 'var(--green)',
                        borderRadius: '2px 2px 0 0',
                      }}
                    />
                    <div
                      style={{
                        height: `${(h.read / max) * 100}%`,
                        background: 'var(--amber)',
                      }}
                    />
                    <div
                      className="subtle"
                      style={{ fontSize: '0.6rem', textAlign: 'center', marginTop: 2 }}
                    >
                      {h.hour % 6 === 0 ? hourLabel(h.hour) : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ---- The delivery board ---- */}
        {!isDraft && (
          <section className="drawer-section">
            <div className="row-between">
              <h3 style={{ marginTop: 0 }}>
                {state ? `Contacts: ${state.replace(/_/g, ' ')}` : 'Every contact'}
              </h3>
              {state && (
                <button className="link-danger" onClick={() => setState('')}>
                  Clear filter
                </button>
              )}
            </div>

            <table className="tasks">
              <thead>
                <tr>
                  <th>Contact</th>
                  <th>State</th>
                  <th>Sent</th>
                  <th>Read</th>
                  <th style={{ textAlign: 'right' }}>Clicks</th>
                  <th>Reply</th>
                </tr>
              </thead>
              <tbody>
                {messages.slice(0, 100).map((m) => (
                  <tr key={m.id}>
                    <td>
                      <div className="contact-name">{m.name || '—'}</div>
                      <div className="phone-row">
                        <span className="subtle">{m.phone}</span>
                        <CopyButton text={m.phone} title="Copy phone number" />
                      </div>
                    </td>
                    <td>
                      <span style={{ color: STATE_COLOR[m.state], fontWeight: 600 }}>
                        {m.state.replace(/_/g, ' ')}
                      </span>
                      {m.errorMessage && (
                        <div className="subtle" style={{ fontSize: '0.72rem' }}>
                          {m.errorMessage}
                        </div>
                      )}
                      {m.skipReason && (
                        <div className="subtle" style={{ fontSize: '0.72rem' }}>
                          {m.skipReason.replace(/_/g, ' ')}
                        </div>
                      )}
                    </td>
                    <td className="subtle">{m.sentAt ? relative(m.sentAt) : '—'}</td>
                    <td className="subtle">{m.readAt ? relative(m.readAt) : '—'}</td>
                    <td
                      style={{
                        textAlign: 'right',
                        fontWeight: 600,
                        color: m.clickCount ? 'var(--green)' : 'inherit',
                      }}
                    >
                      {m.clickCount || '—'}
                    </td>
                    <td className="subtle">{m.replyText || '—'}</td>
                  </tr>
                ))}

                {messages.length === 0 && (
                  <tr>
                    <td colSpan={6} className="subtle">
                      Nobody here.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {messages.length > 100 && (
              <div className="subtle" style={{ marginTop: 8 }}>
                Showing the first 100 of {messages.length}.
              </div>
            )}
          </section>
        )}

        {/* ---- Drip ---- */}
        {campaign.status === 'completed' && (
          <section className="drawer-section">
            <div className="row-between">
              <h3 style={{ marginTop: 0 }}>Follow up automatically</h3>
              <button onClick={() => setDrip(!drip)}>
                {drip ? 'Cancel' : 'Build a drip'}
              </button>
            </div>
            <div className="subtle">
              Chase whoever didn't do what you wanted, on a timer. Each step becomes a
              real campaign, with the same opt-out checks and the same throttle.
            </div>

            {drip && (
              <SequenceForm
                campaign={campaign}
                funnel={funnel}
                onSaved={(msg) => {
                  setDrip(false);
                  setNotice(msg);
                  onChanged?.();
                }}
              />
            )}
          </section>
        )}

        {/* ---- What this campaign spawned ---- */}
        {res.children?.length > 0 && (
          <section className="drawer-section">
            <h3 style={{ marginTop: 0 }}>What came out of this</h3>
            {res.children.map((c) => (
              <div key={c.id} className="row-between" style={{ marginBottom: 6 }}>
                <button
                  className="link-danger"
                  style={{ color: 'var(--accent)' }}
                  onClick={() => onOpenCampaign?.(c.id)}
                >
                  {c.name}
                </button>
                <span className="subtle">
                  {c.status} · {c.stats.sent || 0} sent · {c.stats.clicked || 0} clicked
                </span>
              </div>
            ))}
          </section>
        )}

        {/* ---- Actions ---- */}
        <div className="row-between" style={{ marginTop: 18, gap: 8, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => act('duplicate', {}, 'Duplicated as a new draft.')}>
              Duplicate
            </button>
            {campaign.status === 'sending' && (
              <button onClick={() => act('pause', {}, 'Paused.')}>Pause</button>
            )}
            {campaign.status === 'paused' && (
              <button onClick={() => act('resume', {}, 'Resumed.')}>Resume</button>
            )}
          </div>

          {['sending', 'paused', 'scheduled'].includes(campaign.status) && (
            <button
              className="link-danger"
              onClick={() => {
                if (
                  window.confirm(
                    'Stop this campaign?\n\nWhatever has already gone out stays out — you cannot unsend a WhatsApp message. This only cancels what has not been sent yet.'
                  )
                ) {
                  act('cancel', {}, 'Cancelled.');
                }
              }}
            >
              Stop the campaign
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}
