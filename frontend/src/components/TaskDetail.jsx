import { useEffect, useState } from 'react';
import { api } from '../api';
import { getContact, formatDateTime, priorityClass, statusClass } from '../utils';
import CopyButton from './CopyButton';
import { ENGAGEMENT, clampPct, engagementClass, formatWatch, watchBasisNote } from '../vslStats';

const STATUS_OPTIONS = ['Not Started', 'In Progress', 'Completed'];

export default function TaskDetail({ recordId, onClose, onUpdated }) {
  const [detail, setDetail] = useState(null);
  const [zohoSync, setZohoSync] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [syncMsg, setSyncMsg] = useState('');

  // WhatsApp (WATI)
  const [templates, setTemplates] = useState([]);
  const [waConfigured, setWaConfigured] = useState(true);
  const [waTemplate, setWaTemplate] = useState('');
  const [waParams, setWaParams] = useState({});
  const [waBusy, setWaBusy] = useState(false);
  const [waMsg, setWaMsg] = useState('');

  async function load(guard) {
    setError('');
    try {
      const { data, zohoSync } = await api(`/api/tasks/${encodeURIComponent(recordId)}`);
      if (guard && guard.cancelled) return; // a newer record was selected mid-flight
      setDetail(data);
      setZohoSync(zohoSync);
    } catch (err) {
      if (!(guard && guard.cancelled)) setError(err.message);
    }
  }

  useEffect(() => {
    const guard = { cancelled: false };
    load(guard);
    return () => { guard.cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordId]);

  // Load WhatsApp templates once.
  useEffect(() => {
    api('/api/wati/templates')
      .then((r) => {
        setTemplates(r.templates || []);
        setWaConfigured(r.configured);
      })
      .catch(() => setWaConfigured(false));
  }, []);

  function selectTemplate(name) {
    setWaTemplate(name);
    setWaMsg('');
    const t = templates.find((x) => x.name === name);
    const b = detail?.body || {};
    const init = {};
    (t?.params || []).forEach((p) => {
      if (p === 'name') init[p] = b.Who_Id?.name || '';
      else if (p === 'phone') init[p] = getContact(b).phone || '';
      else init[p] = '';
    });
    setWaParams(init);
  }

  async function sendWhatsapp() {
    setWaBusy(true);
    setWaMsg('');
    try {
      const t = templates.find((x) => x.name === waTemplate);
      const parameters = (t?.params || []).map((p) => ({ name: p, value: waParams[p] || '' }));
      const { data } = await api(`/api/tasks/${encodeURIComponent(recordId)}/whatsapp`, {
        method: 'POST',
        body: { template: waTemplate, parameters },
      });
      setDetail(data);
      setWaMsg('✓ WhatsApp sent');
      onUpdated?.();
    } catch (err) {
      setWaMsg('Failed: ' + err.message);
      // Refresh so the failed attempt shows in the log.
      load();
    } finally {
      setWaBusy(false);
    }
  }

  function reportSync(sync, what) {
    if (sync?.ok) setSyncMsg(`${what} synced to Zoho.`);
    else if (sync?.skipped) setSyncMsg(`${what} saved locally (Zoho sync not configured).`);
    else setSyncMsg(`${what} saved locally. Zoho sync failed: ${sync?.error || 'unknown'}`);
  }

  async function changeStatus(status) {
    setBusy(true);
    setError('');
    try {
      const { data, zohoSync } = await api(
        `/api/tasks/${encodeURIComponent(recordId)}/status`,
        { method: 'PATCH', body: { status } }
      );
      setDetail(data);
      reportSync(zohoSync, 'Status');
      onUpdated?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitNote(e) {
    e.preventDefault();
    if (!note.trim()) return;
    setBusy(true);
    setError('');
    try {
      const { data, zohoSync } = await api(
        `/api/tasks/${encodeURIComponent(recordId)}/notes`,
        { method: 'POST', body: { text: note } }
      );
      setDetail(data);
      setNote('');
      reportSync(zohoSync, 'Note');
      onUpdated?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const task = detail?.body || {};
  const contact = getContact(task);
  const tags = Array.isArray(task.Tag) ? task.Tag : [];

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>{task.Subject || task.Who_Id?.name || 'Lead detail'}</h2>
          <button className="link-danger" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="error">{error}</div>}
        {syncMsg && <div className="notice">{syncMsg}</div>}
        {!zohoSync && (
          <div className="hint">
            Zoho write-back is not configured — changes are saved locally only.
          </div>
        )}

        {!detail ? (
          <p className="subtle">Loading…</p>
        ) : (
          <>
            {/* Status action */}
            <section className="drawer-section">
              <div className="row-between">
                <div>
                  <span className="field-label">Status</span>
                  <div>
                    <span className={statusClass(task.Status)}>{task.Status || '—'}</span>
                  </div>
                </div>
                <div className="status-actions">
                  <select
                    value={task.Status || ''}
                    disabled={busy}
                    onChange={(e) => changeStatus(e.target.value)}
                  >
                    <option value="" disabled>
                      Change status…
                    </option>
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  {task.Status !== 'Completed' && (
                    <button disabled={busy} onClick={() => changeStatus('Completed')}>
                      Mark complete
                    </button>
                  )}
                </div>
              </div>
            </section>

            {/* Fields */}
            <section className="drawer-section fields">
              <Field label="Contact">{task.Who_Id?.name || '—'}</Field>
              <Field label="Phone">
                {contact.phone ? (
                  <span className="phone-row">
                    <a href={`tel:${contact.phone}`}>{contact.phone}</a>
                    <CopyButton text={contact.phone} title="Copy phone number" />
                  </span>
                ) : (
                  <span className="subtle">— (add Phone field in Zoho)</span>
                )}
              </Field>
              <Field label="Email">
                {contact.email ? (
                  <a href={`mailto:${contact.email}`}>{contact.email}</a>
                ) : (
                  <span className="subtle">— (add Email field in Zoho)</span>
                )}
              </Field>
              <Field label="Owner">{task.Owner?.name || '—'}</Field>
              <Field label="Priority">
                <span className={priorityClass(task.Priority)}>{task.Priority || '—'}</span>
              </Field>
              <Field label="Due date">{task.Due_Date || '—'}</Field>
              <Field label="Created">{formatDateTime(task.Created_Time)}</Field>
              <Field label="Created by">{task.Created_By?.name || '—'}</Field>
              <Field label="Closed">{formatDateTime(task.Closed_Time)}</Field>
              <Field label="Zoho ID">{detail.zohoId || '—'}</Field>
            </section>

            <section className="drawer-section">
              <span className="field-label">Description</span>
              <p className="desc">{task.Description || <span className="subtle">No description</span>}</p>
            </section>

            <section className="drawer-section">
              <span className="field-label">Tags</span>
              <div className="breakdown">
                {tags.length ? (
                  tags.map((t, i) => (
                    <span key={i} className="badge badge-normal">
                      {typeof t === 'string' ? t : t.name}
                    </span>
                  ))
                ) : (
                  <span className="subtle">No tags</span>
                )}
              </div>
            </section>

            {/* Where this lead came from — rendered only when one is linked. */}
            {detail.acquisition && <Acquisition acq={detail.acquisition} />}

            {/* What they actually watched of the VSL. Absent — not empty — when
                the VSL is unconfigured, the number is too short to join, or this
                person was never sent the video. Sits after acquisition so the
                drawer reads: where they came from, what they watched, what we
                did about it. */}
            {detail.vsl && <VslWatch vsl={detail.vsl} />}

            {/* All follow-up tasks for this contact */}
            <section className="drawer-section">
              <span className="field-label">
                Follow-ups for this contact ({detail.taskHistory?.length || 0})
              </span>
              <ul className="timeline">
                {(!detail.taskHistory || detail.taskHistory.length === 0) && (
                  <li className="subtle">No other follow-ups</li>
                )}
                {[...(detail.taskHistory || [])]
                  .sort((a, b) => new Date(b.createdTime || 0) - new Date(a.createdTime || 0))
                  .map((h, i) => (
                    <li key={i}>
                      <div>
                        <b>{h.subject || '—'}</b>{' '}
                        <span className={statusClass(h.status)}>{h.status || '—'}</span>
                      </div>
                      <span className="subtle">
                        due {h.dueDate || '—'} · created {formatDateTime(h.createdTime)}
                      </span>
                    </li>
                  ))}
              </ul>
            </section>

            {/* History */}
            <section className="drawer-section">
              <span className="field-label">Status history</span>
              <ul className="timeline">
                {(detail.statusHistory || []).length === 0 && (
                  <li className="subtle">No history yet</li>
                )}
                {[...(detail.statusHistory || [])].reverse().map((h, i) => (
                  <li key={i}>
                    <span className={statusClass(h.status)}>{h.status}</span>
                    <span className="subtle">
                      {formatDateTime(h.changedAt)} · {h.source}
                      {h.by ? ` · ${h.by}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            {/* WhatsApp (WATI) */}
            {waConfigured && (
              <section className="drawer-section">
                <span className="field-label">Send WhatsApp</span>
                {!contact.phone && (
                  <div className="hint" style={{ marginTop: '0.5rem' }}>
                    This lead has no phone number.
                  </div>
                )}
                {waMsg && (
                  <div
                    className={waMsg.startsWith('Failed') ? 'error' : 'notice'}
                    style={{ marginTop: '0.5rem', marginBottom: 0 }}
                  >
                    {waMsg}
                  </div>
                )}
                <div className="wa-form">
                  <select value={waTemplate} onChange={(e) => selectTemplate(e.target.value)}>
                    <option value="">Choose a template…</option>
                    {templates.map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.name}
                        {t.params.length ? ` — ${t.params.join(', ')}` : ''}
                      </option>
                    ))}
                  </select>

                  {waTemplate &&
                    (templates.find((t) => t.name === waTemplate)?.params || []).map((p) => (
                      <label key={p} className="wa-param">
                        {p}
                        <input
                          value={waParams[p] || ''}
                          onChange={(e) =>
                            setWaParams((v) => ({ ...v, [p]: e.target.value }))
                          }
                        />
                      </label>
                    ))}

                  <button
                    disabled={waBusy || !waTemplate || !contact.phone}
                    onClick={sendWhatsapp}
                  >
                    {waBusy ? 'Sending…' : 'Send WhatsApp'}
                  </button>
                </div>

                {detail.whatsappLog?.length > 0 && (
                  <ul className="notes" style={{ marginTop: '0.75rem' }}>
                    {[...detail.whatsappLog].reverse().map((w, i) => (
                      <li key={i}>
                        <div>
                          {w.ok ? '✅' : '❌'} <b>{w.template}</b> → {w.number}
                        </div>
                        <div className="subtle">
                          {w.sentBy} · {formatDateTime(w.sentAt)}
                          {w.error ? ` · ${w.error}` : ''}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {/* Notes */}
            <section className="drawer-section">
              <span className="field-label">Notes</span>
              <ul className="notes">
                {(detail.notes || []).length === 0 && <li className="subtle">No notes yet</li>}
                {[...(detail.notes || [])].reverse().map((n, i) => (
                  <li key={i}>
                    <div>{n.text}</div>
                    <div className="subtle">
                      {n.author || 'unknown'} · {formatDateTime(n.createdAt)}
                      {n.syncedToZoho ? ' · synced' : ''}
                    </div>
                  </li>
                ))}
              </ul>
              <form className="note-form" onSubmit={submitNote}>
                <textarea
                  rows={2}
                  value={note}
                  placeholder="Add a note…"
                  onChange={(e) => setNote(e.target.value)}
                />
                <button type="submit" disabled={busy || !note.trim()}>
                  Add note
                </button>
              </form>
            </section>
          </>
        )}
      </aside>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="field-value">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------
//
// Where this lead came from, what it answered on the form, and — for admins —
// what it cost. The whole block is absent (not nulled) when the task has no ad
// lead linked to it, and the cost object is absent for sales users, so both are
// rendered by presence: no acquisition, no section; no cost, no cost row.

// Rupees the way the retired CRM showed them: Indian digit grouping, so
// 146521.8 reads ₹1,46,521.80 rather than ₹146,521.80.
const RUPEES = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function rupees(value) {
  const n = Number(value);
  return Number.isFinite(n) ? RUPEES.format(n) : null;
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** '2026-07' → 'Jul 2026'. Anything else is shown as it arrived. */
function monthLabel(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) return month || '—';
  const name = MONTH_NAMES[Number(m[2]) - 1];
  return name ? `${name} ${m[1]}` : month;
}

// The drawer's standard "nothing here" mark.
const dash = <span className="subtle">—</span>;

function value(v) {
  return v == null || v === '' ? dash : v;
}

/**
 * How the campaign was matched, in the resolver's own words.
 *
 * `id` and `exact` are claims Meta's data supports; `normalized` and `alias` are
 * not, and they are not the same kind of guess — one is a string comparison that
 * ignored punctuation, the other is an admin's hand-written mapping. Same visual
 * treatment as the task-category badge when it was read out of the subject line
 * (see TaskTable), because it means the same thing: this is inferred.
 */
const MATCH_NOTE = {
  id: { inferred: false, tip: 'Meta reported this campaign with the lead.' },
  exact: { inferred: false, tip: 'The utm_campaign tag matched this campaign name exactly.' },
  normalized: {
    inferred: true,
    tip:
      'Inferred — the utm_campaign tag matched this campaign name only after ignoring ' +
      'case, spacing and punctuation. Meta did not report the campaign itself.',
  },
  alias: {
    inferred: true,
    tip:
      'Inferred — an admin mapped this utm_campaign string to this campaign by hand in ' +
      'the alias table. It is an operator’s assertion, not something Meta reported.',
  },
};

function Campaign({ campaign }) {
  if (!campaign) return dash;
  const note = MATCH_NOTE[campaign.resolvedBy] || null;
  const name = campaign.name || campaign.id;
  if (!name) return dash;
  return (
    <>
      <span
        className={note && note.inferred ? 'acq-campaign acq-inferred' : 'acq-campaign'}
        title={note ? note.tip : undefined}
      >
        {name}
      </span>
      {note && note.inferred && (
        <span className="acq-inferred-tag" title={note.tip}>
          inferred
        </span>
      )}
    </>
  );
}

/** Long, so it is clipped to one line — the full value is the hover title. */
function Url({ href }) {
  if (!href) return dash;
  return (
    <a className="acq-url" href={href} title={href} target="_blank" rel="noreferrer">
      {href}
    </a>
  );
}

function Acquisition({ acq }) {
  const utm = acq.utm || {};
  const qual = acq.qualification || {};
  const cost = acq.cost; // absent entirely on a sales-role response
  const sourceMedium = [utm.source, utm.medium].filter(Boolean).join(' · ');

  return (
    <section className="drawer-section">
      <span className="field-label">Acquisition</span>

      <div className="fields acq-grid">
        <Field label="Source">
          {acq.source === 'meta' ? 'Meta form' : 'Web form'}
          {acq.formLabel && <span className="acq-basis">{acq.formLabel}</span>}
        </Field>
        <Field label="Campaign">
          <Campaign campaign={acq.campaign} />
        </Field>
        <Field label="Captured">{acq.capturedAt ? formatDateTime(acq.capturedAt) : dash}</Field>
      </div>

      {/* Admins only. Absent — not blanked — for everyone else. */}
      {cost && (
        <div className="acq-group">
          <span className="field-label">Estimated cost</span>
          <div className="field-value acq-cost">{value(rupees(cost.estimated))}</div>
          <span className="acq-basis">
            {rupees(cost.campaignSpend)} campaign spend ÷ {cost.leadCount} leads in{' '}
            {monthLabel(cost.month)}
          </span>
          <span className="acq-basis">
            This lead’s share of that month’s campaign spend, split evenly across the
            campaign’s leads — an apportionment, not a per-person cost Meta reported.
          </span>
        </div>
      )}

      <div className="acq-group">
        <span className="field-label acq-subhead">UTM tags</span>
        <div className="fields acq-grid">
          <Field label="Source / medium">{value(sourceMedium)}</Field>
          <Field label="Campaign">{value(utm.campaign)}</Field>
          <Field label="Content">{value(utm.content)}</Field>
          <Field label="Term">{value(utm.term)}</Field>
        </div>
      </div>

      <div className="acq-group">
        <span className="field-label acq-subhead">Landing page</span>
        <div className="acq-stack">
          <Field label="Landing URL">
            <Url href={acq.landingUrl} />
          </Field>
          <Field label="Referrer">
            <Url href={acq.referrer} />
          </Field>
        </div>
      </div>

      <div className="acq-group">
        <span className="field-label acq-subhead">Qualification answers</span>
        <div className="fields acq-grid">
          <Field label="CA status">{value(qual.caStatus)}</Field>
          <Field label="Attempt">{value(qual.attempt)}</Field>
          <Field label="Language">{value(qual.language)}</Field>
          <Field label="City">{value(qual.city)}</Field>
          <Field label="State">{value(qual.state)}</Field>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// VSL watch time
// ---------------------------------------------------------------------------
//
// The minutes here are the PEAK ever recorded in the VSL's event log, not the
// figure on its lead record — that one is overwritten on every beacon, so it
// falls when somebody reopens the video. On the rare row where no events exist
// the server falls back to it and stamps `basis: 'lead'`, and the note at the
// bottom of this panel says so. A number we inferred must not read like one we
// measured.

function VslWatch({ vsl }) {
  const watch = vsl.watch || {};
  const src = vsl.leadSource || {};
  const note = watchBasisNote(watch.basis);

  return (
    <section className="drawer-section">
      <span className="field-label">VSL watch time</span>

      <div className="fields acq-grid">
        <Field label="Minutes watched">
          <span className="vsl-minutes">{formatWatch(watch.seconds, watch.percentage)}</span>
        </Field>
        <Field label="Engagement">
          <span className={engagementClass(vsl.engagement)} title={ENGAGEMENT[vsl.engagement]?.hint}>
            {ENGAGEMENT[vsl.engagement]?.label || vsl.engagement}
          </span>
        </Field>
        <Field label="Lead source">
          {value(src.key)}
          {src.basis === 'task' && (
            <span className="acq-basis">
              From the linked ad lead, not from Bigin&apos;s lead source field.
            </span>
          )}
        </Field>
      </div>

      {watch.seconds > 0 && (
        <div className="vsl-bar" title={`${Math.round(watch.percentage)}% of the video`}>
          <div
            className={watch.completed ? 'vsl-bar-fill vsl-bar-done' : 'vsl-bar-fill'}
            style={{ width: `${clampPct(watch.percentage)}%` }}
          />
        </div>
      )}

      <div className="acq-group">
        <span className="field-label acq-subhead">Timeline</span>
        <div className="fields acq-grid">
          <Field label="Link sent">{vsl.linkSentAt ? formatDateTime(vsl.linkSentAt) : dash}</Field>
          <Field label="First opened">
            {vsl.firstOpenedAt ? formatDateTime(vsl.firstOpenedAt) : dash}
          </Field>
          <Field label="First played">
            {vsl.firstPlayAt ? formatDateTime(vsl.firstPlayAt) : dash}
          </Field>
          <Field label="Last activity">
            {vsl.lastActivityAt ? formatDateTime(vsl.lastActivityAt) : dash}
          </Field>
          <Field label="Times opened">{vsl.openCount || dash}</Field>
          <Field label="Last event">{value(vsl.lastEventType)}</Field>
        </div>
      </div>

      {note && <span className="acq-basis">{note}</span>}
    </section>
  );
}
