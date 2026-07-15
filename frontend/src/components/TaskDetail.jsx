import { useEffect, useState } from 'react';
import { api } from '../api';
import { getContact, formatDateTime, priorityClass, statusClass } from '../utils';
import CopyButton from './CopyButton';

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
