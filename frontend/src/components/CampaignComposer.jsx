import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { money } from '../campaigns';

/**
 * The WATI-style broadcast composer: one screen, a live WhatsApp preview on the right,
 * and a Send button you can actually reach. It replaces the old draft → open → preview
 * → send hop, which was the thing that made sending feel like work.
 *
 * The message still starts as a draft under the hood (so a mis-click can't fire 5,000
 * messages), but the composer creates it and sends it in one action, so from the
 * user's side it is a single "Send now".
 */
export default function CampaignComposer({ onClose, onSent }) {
  const [templates, setTemplates] = useState([]);
  const [segments, setSegments] = useState([]);
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');

  const [name, setName] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [values, setValues] = useState({}); // { paramName: {source, value, fallback} }
  const [audience, setAudience] = useState({ type: 'all', segmentId: '', tag: '' });
  const [count, setCount] = useState(null);
  const [ratePerMinute, setRate] = useState(20);
  const [trackLinks, setTrackLinks] = useState(true);
  const [testNumber, setTestNumber] = useState('');
  const [scheduleAt, setScheduleAt] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [t, s, tg] = await Promise.all([
          api('/api/campaigns/templates'),
          api('/api/segments'),
          api('/api/contacts/tags'),
        ]);
        setTemplates((t.data || []).filter((x) => x.status === 'APPROVED'));
        setSegments(s.data || []);
        setTags(tg.data || []);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const template = useMemo(
    () => templates.find((t) => t.name === templateName),
    [templates, templateName]
  );

  const chooseTemplate = (tName) => {
    setTemplateName(tName);
    const t = templates.find((x) => x.name === tName);
    if (!name && t) setName(`${t.name} — ${new Date().toLocaleDateString()}`);
    // Pre-fill each variable: a "name"-ish param defaults to the contact's name,
    // everything else to WATI's stored sample value, so the preview is instantly real.
    const next = {};
    (t?.params || []).forEach((p) => {
      const isName = /name/i.test(p);
      next[p] = isName
        ? { source: 'attribute', value: 'name', fallback: t.sampleValues?.[p] || 'there' }
        : { source: 'static', value: t.sampleValues?.[p] || '' };
    });
    setValues(next);
  };

  const setVal = (p, patch) => setValues((v) => ({ ...v, [p]: { ...v[p], ...patch } }));

  // Live recipient count as the audience changes. This is the number that stops an
  // accidental send to the whole list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let rule = null;
        if (audience.type === 'all') rule = { match: 'all', conditions: [] };
        else if (audience.type === 'tag' && audience.tag) {
          rule = { match: 'all', conditions: [{ field: 'tags', op: 'in', value: [audience.tag] }] };
        } else if (audience.type === 'segment' && audience.segmentId) {
          const seg = segments.find((s) => s.id === audience.segmentId);
          rule = seg?.rule;
        }
        if (!rule) {
          if (!cancelled) setCount(null);
          return;
        }
        const res = await api('/api/segments/preview', { method: 'POST', body: { rule } });
        if (!cancelled) setCount(res);
      } catch {
        if (!cancelled) setCount(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [audience, segments]);

  const variablesPayload = () =>
    Object.entries(values).map(([n, b]) => ({
      name: n,
      source: b.source,
      value: b.value || '',
      fallback: b.fallback || '',
    }));

  const buildAudience = () => {
    if (audience.type === 'all') return { type: 'all' };
    if (audience.type === 'tag') {
      return {
        type: 'segment',
        rule: { match: 'all', conditions: [{ field: 'tags', op: 'in', value: [audience.tag] }] },
      };
    }
    return { type: 'segment', segmentId: audience.segmentId };
  };

  const audienceReady =
    audience.type === 'all' ||
    (audience.type === 'tag' && audience.tag) ||
    (audience.type === 'segment' && audience.segmentId);

  const canSend = name.trim() && templateName && audienceReady && (count?.count ?? 0) > 0;

  // Remembers a draft created by an attempt whose send/schedule then failed, so a retry
  // reuses (and updates) that draft instead of piling up orphan drafts.
  const createdIdRef = useRef(null);

  const create = async () => {
    const body = {
      name,
      templateName,
      templateCategory: template?.category || 'MARKETING',
      templateLanguage: template?.language || '',
      variables: variablesPayload(),
      audience: buildAudience(),
      ratePerMinute: Number(ratePerMinute) || 20,
      trackLinks,
    };
    if (createdIdRef.current) {
      await api(`/api/campaigns/${createdIdRef.current}`, { method: 'PATCH', body });
      return createdIdRef.current;
    }
    const res = await api('/api/campaigns', { method: 'POST', body });
    createdIdRef.current = res.data.id;
    return res.data.id;
  };

  const sendNow = async () => {
    if (
      !window.confirm(
        `Send "${name}" to ${count?.count ?? 0} contact(s) on WhatsApp now?\n\nThis cannot be undone.`
      )
    ) {
      return;
    }
    setBusy('send');
    setError('');
    try {
      const id = await create();
      const res = await api(`/api/campaigns/${id}/send`, { method: 'POST', body: {} });
      onSent(id, res.message || 'Sending now.');
    } catch (e) {
      setError(e.message);
      setBusy('');
    }
  };

  const schedule = async () => {
    setBusy('schedule');
    setError('');
    try {
      const id = await create();
      await api(`/api/campaigns/${id}/schedule`, {
        method: 'POST',
        body: { scheduledAt: new Date(scheduleAt).toISOString() },
      });
      onSent(id, `Scheduled for ${new Date(scheduleAt).toLocaleString()}.`);
    } catch (e) {
      setError(e.message);
      setBusy('');
    }
  };

  const saveDraft = async () => {
    setBusy('draft');
    setError('');
    try {
      const id = await create();
      onSent(id, 'Saved as a draft.');
    } catch (e) {
      setError(e.message);
      setBusy('');
    }
  };

  const sendTest = async () => {
    setBusy('test');
    setError('');
    setNotice('');
    try {
      const res = await api('/api/campaigns/test-send', {
        method: 'POST',
        body: {
          phone: testNumber,
          templateName,
          // For a test we need concrete values, so fall back to the sample/fallback.
          variables: Object.fromEntries(
            Object.entries(values).map(([n, b]) => [
              n,
              b.source === 'attribute' ? b.fallback || 'there' : b.value || '',
            ])
          ),
        },
      });
      setNotice(res.message);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="composer">
      <div className="composer-bar">
        <button onClick={onClose}>← Back</button>
        <strong>New campaign</strong>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={saveDraft} disabled={!templateName || busy}>
            Save draft
          </button>
          <button
            type="submit"
            onClick={sendNow}
            disabled={!canSend || busy}
            title={!canSend ? 'Pick a template and an audience with at least one contact' : ''}
          >
            {busy === 'send' ? 'Sending…' : `Send to ${count?.count ?? 0} now`}
          </button>
        </div>
      </div>

      <div className="composer-body">
        {/* LEFT: the controls */}
        <div className="composer-form">
          {error && <div className="error">{error}</div>}
          {notice && <div className="notice">{notice}</div>}

          {loading ? (
            <p className="subtle">Loading templates…</p>
          ) : (
            <>
              <section className="composer-step">
                <div className="step-num">1</div>
                <div className="step-body">
                  <h3>Name &amp; template</h3>
                  <label>
                    Campaign name
                    <input
                      type="text"
                      value={name}
                      placeholder="October Inter G2 push"
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <label style={{ marginTop: 10 }}>
                    Template
                    <select value={templateName} onChange={(e) => chooseTemplate(e.target.value)}>
                      <option value="">Choose an approved template…</option>
                      {templates.map((t) => (
                        <option key={t.name} value={t.name}>
                          {t.name} ({t.category})
                        </option>
                      ))}
                    </select>
                  </label>
                  {templates.length === 0 && (
                    <div className="hint">
                      No approved templates found in WATI. You can only send pre-approved
                      templates on WhatsApp.
                    </div>
                  )}
                </div>
              </section>

              {template && template.params.length > 0 && (
                <section className="composer-step">
                  <div className="step-num">2</div>
                  <div className="step-body">
                    <h3>Fill in the blanks</h3>
                    <div className="subtle" style={{ marginBottom: 8 }}>
                      The preview on the right updates as you type.
                    </div>
                    {template.params.map((p) => {
                      const b = values[p] || {};
                      return (
                        <div key={p} className="var-row">
                          <code className="var-tag">{`{{${p}}}`}</code>
                          <select
                            value={b.source || 'static'}
                            onChange={(e) => setVal(p, { source: e.target.value, value: '' })}
                          >
                            <option value="static">Same for all</option>
                            <option value="attribute">Contact's {p}</option>
                            <option value="link">Tracked link</option>
                          </select>
                          {b.source === 'attribute' ? (
                            <input
                              type="text"
                              placeholder="If missing, use…"
                              value={b.fallback || ''}
                              onChange={(e) => setVal(p, { fallback: e.target.value })}
                            />
                          ) : (
                            <input
                              type="text"
                              placeholder={b.source === 'link' ? 'https://…' : 'Text'}
                              value={b.value || ''}
                              onChange={(e) => setVal(p, { value: e.target.value })}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              <section className="composer-step">
                <div className="step-num">{template && template.params.length ? 3 : 2}</div>
                <div className="step-body">
                  <h3>Who gets it</h3>
                  <div className="quick-tabs" style={{ marginBottom: 10 }}>
                    {[
                      ['all', 'Everyone'],
                      ['tag', 'By tag'],
                      ['segment', 'Saved audience'],
                    ].map(([k, label]) => (
                      <button
                        key={k}
                        className={audience.type === k ? 'quick-tab active' : 'quick-tab'}
                        onClick={() => setAudience({ type: k, segmentId: '', tag: '' })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {audience.type === 'tag' && (
                    <label>
                      Tag
                      <select
                        value={audience.tag}
                        onChange={(e) => setAudience({ ...audience, tag: e.target.value })}
                      >
                        <option value="">Choose a tag…</option>
                        {tags.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {audience.type === 'segment' && (
                    <label>
                      Audience
                      <select
                        value={audience.segmentId}
                        onChange={(e) => setAudience({ ...audience, segmentId: e.target.value })}
                      >
                        <option value="">Choose one…</option>
                        {segments.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name} {s.lastCount != null ? `(~${s.lastCount})` : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  <div className="reach-line">
                    {count == null ? (
                      <span className="subtle">Pick an audience to see the reach.</span>
                    ) : (
                      <>
                        <strong style={{ color: count.count ? 'var(--green)' : 'var(--red)' }}>
                          {count.count} will receive it
                        </strong>
                        {count.excluded > 0 && (
                          <span className="subtle">
                            {' '}
                            · {count.excluded} excluded (opted out / unreachable)
                          </span>
                        )}
                        {template && (
                          <span className="subtle">
                            {' '}
                            · about{' '}
                            {money(
                              (count.count || 0) *
                                (template.category === 'MARKETING' ? 0.78 : 0.115)
                            )}
                          </span>
                        )}
                      </>
                    )}
                  </div>

                  {(tags.length === 0 && audience.type === 'tag') && (
                    <div className="hint">
                      No tags yet. Add contacts with tags, or use "Everyone".
                    </div>
                  )}
                </div>
              </section>

              <section className="composer-step">
                <div className="step-num">{template && template.params.length ? 4 : 3}</div>
                <div className="step-body">
                  <h3>Before you send</h3>

                  <label style={{ marginBottom: 10 }}>
                    Send a test to your own number
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        type="text"
                        placeholder="9876543210"
                        value={testNumber}
                        onChange={(e) => setTestNumber(e.target.value)}
                      />
                      <button
                        onClick={sendTest}
                        disabled={!testNumber.trim() || !templateName || busy === 'test'}
                      >
                        {busy === 'test' ? 'Sending…' : 'Send test'}
                      </button>
                    </div>
                  </label>

                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'end' }}>
                    <label>
                      Messages / minute
                      <input
                        type="number"
                        min="1"
                        max="200"
                        value={ratePerMinute}
                        onChange={(e) => setRate(e.target.value)}
                        style={{ width: 90 }}
                      />
                    </label>
                    <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={trackLinks}
                        style={{ width: 'auto' }}
                        onChange={(e) => setTrackLinks(e.target.checked)}
                      />
                      Track link clicks
                    </label>
                  </div>

                  <div className="row-between" style={{ marginTop: 14, gap: 8 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
                      <label>
                        Or schedule for later
                        <input
                          type="datetime-local"
                          value={scheduleAt}
                          onChange={(e) => setScheduleAt(e.target.value)}
                        />
                      </label>
                      <button onClick={schedule} disabled={!canSend || !scheduleAt || busy}>
                        {busy === 'schedule' ? 'Scheduling…' : 'Schedule'}
                      </button>
                    </div>
                  </div>

                  <div className="subtle" style={{ marginTop: 10 }}>
                    Slow sending protects your number's WhatsApp quality rating. 20/min is
                    safe for a cold number.
                  </div>
                </div>
              </section>
            </>
          )}
        </div>

        {/* RIGHT: the live WhatsApp preview */}
        <div className="composer-preview">
          <PhonePreview template={template} values={values} />
        </div>
      </div>
    </div>
  );
}

/** A WhatsApp-style message bubble that renders the template as the contact will see it. */
function PhonePreview({ template, values }) {
  const rendered = useMemo(() => {
    if (!template) return '';
    let text = template.body || '';
    // Substitute {{param}} with the chosen value, mirroring what the contact receives.
    for (const p of template.params || []) {
      const b = values[p] || {};
      const shown =
        b.source === 'attribute'
          ? `[${b.value || p}]` // a real send fills this per-contact; show the field name
          : b.source === 'link'
            ? b.value || '[link]'
            : b.value || `{{${p}}}`;
      text = text.replaceAll(`{{${p}}}`, shown);
    }
    return text;
  }, [template, values]);

  return (
    <div className="phone">
      <div className="phone-top">WhatsApp preview</div>
      <div className="phone-screen">
        {!template ? (
          <div className="subtle" style={{ margin: 'auto', textAlign: 'center', padding: 20 }}>
            Pick a template to see how the message will look.
          </div>
        ) : (
          <div className="wa-bubble">
            {template.header?.text && <div className="wa-header">{template.header.text}</div>}
            <div className="wa-body">{rendered}</div>
            {template.footer && <div className="wa-footer">{template.footer}</div>}
            <div className="wa-time">
              {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
            {(template.buttons || []).length > 0 && (
              <div className="wa-buttons">
                {template.buttons.map((b, i) => (
                  <div key={i} className="wa-button">
                    {b.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
