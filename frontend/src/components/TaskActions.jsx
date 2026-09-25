import { useEffect, useState } from 'react';
import { api } from '../api';
import { getContact, priorityClass, statusClass } from '../utils';

const STATUS_OPTIONS = ['Not Started', 'In Progress', 'Completed'];

/** A stored Task body is one task object or an array of them; the first is the task. */
export function taskBody(task) {
  const body = task?.body;
  return (Array.isArray(body) ? body[0] : body) || {};
}

/**
 * What a rep can DO to a follow-up: change its status, add a note, send a
 * WhatsApp template. Every write targets `task.id` and, once it lands, calls
 * `onChanged` so the owner can refetch — the result (the new status, the note,
 * the WhatsApp send) shows up in the owner's own history, not in here.
 */
export default function TaskActions({ task, zohoSync = true, onChanged }) {
  const id = task.id;
  const body = taskBody(task);
  const contact = getContact(body);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [syncMsg, setSyncMsg] = useState('');

  // WhatsApp (WATI)
  const [templates, setTemplates] = useState([]);
  const [waConfigured, setWaConfigured] = useState(true);
  const [waTemplate, setWaTemplate] = useState('');
  const [waParams, setWaParams] = useState({});
  const [waBusy, setWaBusy] = useState(false);
  const [waMsg, setWaMsg] = useState('');

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
    const init = {};
    (t?.params || []).forEach((p) => {
      if (p === 'name') init[p] = body.Who_Id?.name || '';
      else if (p === 'phone') init[p] = contact.phone || '';
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
      await api(`/api/tasks/${encodeURIComponent(id)}/whatsapp`, {
        method: 'POST',
        body: { template: waTemplate, parameters },
      });
      setWaMsg('✓ WhatsApp sent');
    } catch (err) {
      setWaMsg('Failed: ' + err.message);
    } finally {
      setWaBusy(false);
    }
    // Either way: a failed attempt is logged too, and shows in the history.
    onChanged?.();
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
      const { zohoSync: sync } = await api(`/api/tasks/${encodeURIComponent(id)}/status`, {
        method: 'PATCH',
        body: { status },
      });
      reportSync(sync, 'Status');
      onChanged?.();
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
      const { zohoSync: sync } = await api(`/api/tasks/${encodeURIComponent(id)}/notes`, {
        method: 'POST',
        body: { text: note },
      });
      setNote('');
      reportSync(sync, 'Note');
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <div className="error">{error}</div>}
      {syncMsg && <div className="notice">{syncMsg}</div>}
      {!zohoSync && (
        <div className="hint">Zoho write-back is not configured — changes are saved locally only.</div>
      )}

      {/* Status */}
      <section className="drawer-section">
        <span className="field-label">Latest follow-up</span>
        <div className="lp-task-subject">{body.Subject || '—'}</div>
        <div className="breakdown" style={{ marginTop: '0.4rem' }}>
          <span className={statusClass(body.Status)}>{body.Status || '—'}</span>
          {body.Priority && <span className={priorityClass(body.Priority)}>{body.Priority}</span>}
          {body.Due_Date && <span className="subtle">due {body.Due_Date}</span>}
        </div>
        <div className="status-actions" style={{ marginTop: '0.75rem' }}>
          <select
            value={body.Status || ''}
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
          {body.Status !== 'Completed' && (
            <button disabled={busy} onClick={() => changeStatus('Completed')}>
              Mark complete
            </button>
          )}
        </div>
      </section>

      {/* Note */}
      <section className="drawer-section">
        <span className="field-label">Add a note</span>
        <form className="note-form" onSubmit={submitNote}>
          <textarea
            rows={3}
            value={note}
            placeholder="Add a note…"
            onChange={(e) => setNote(e.target.value)}
          />
          <button type="submit" disabled={busy || !note.trim()}>
            Add note
          </button>
        </form>
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
                    onChange={(e) => setWaParams((v) => ({ ...v, [p]: e.target.value }))}
                  />
                </label>
              ))}

            <button disabled={waBusy || !waTemplate || !contact.phone} onClick={sendWhatsapp}>
              {waBusy ? 'Sending…' : 'Send WhatsApp'}
            </button>
          </div>
        </section>
      )}
    </>
  );
}
