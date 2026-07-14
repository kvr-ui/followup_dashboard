import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { TEMPLATE_CATEGORIES } from '../campaigns';

/**
 * Create a campaign. Always as a DRAFT — this drawer cannot send anything.
 *
 * Sending lives on the detail page, behind an audience preview. That separation is
 * deliberate: a form with a Send button at the bottom is a form someone will submit
 * with the wrong audience selected, and there is no undo on a WhatsApp message.
 */
export default function CampaignForm({ onClose, onSaved }) {
  const [templates, setTemplates] = useState([]);
  const [segments, setSegments] = useState([]);
  const [attributes, setAttributes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    name: '',
    description: '',
    templateName: '',
    templateCategory: 'MARKETING',
    templateLanguage: '',
    audienceType: 'segment',
    segmentId: '',
    ratePerMinute: 20,
    trackLinks: true,
    requiresApproval: false,
  });

  const [bindings, setBindings] = useState({});

  useEffect(() => {
    (async () => {
      try {
        const [t, s, schema] = await Promise.all([
          api('/api/campaigns/templates'),
          api('/api/segments'),
          api('/api/segments/schema'),
        ]);
        setTemplates(t.data || []);
        setSegments(s.data || []);
        setAttributes(
          (schema.fields || [])
            .filter((f) => f.field.startsWith('attributes.') || ['name', 'email'].includes(f.field))
            .map((f) => ({ field: f.field, label: f.label }))
        );
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const template = useMemo(
    () => templates.find((t) => t.name === form.templateName),
    [templates, form.templateName]
  );

  // Picking a template resets the bindings — the old ones belonged to a different
  // set of placeholders, and silently carrying them over produces a message with
  // someone else's variables in it.
  const chooseTemplate = (name) => {
    const t = templates.find((x) => x.name === name);
    setForm((f) => ({
      ...f,
      templateName: name,
      templateCategory: (t && t.category) || 'MARKETING',
      templateLanguage: (t && t.language) || '',
    }));
    const next = {};
    (t?.params || []).forEach((p) => {
      // Guess: a param called "name" almost always wants the contact's name.
      const guess = ['name', 'email'].includes(p.toLowerCase())
        ? { source: 'attribute', value: p.toLowerCase(), fallback: '' }
        : { source: 'static', value: '', fallback: '' };
      next[p] = guess;
    });
    setBindings(next);
  };

  const setBinding = (param, patch) =>
    setBindings((b) => ({ ...b, [param]: { ...b[param], ...patch } }));

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const variables = Object.entries(bindings).map(([name, b]) => ({
        name,
        source: b.source,
        value: b.value || '',
        fallback: b.fallback || '',
      }));

      const audience =
        form.audienceType === 'all'
          ? { type: 'all' }
          : { type: 'segment', segmentId: form.segmentId };

      const res = await api('/api/campaigns', {
        method: 'POST',
        body: {
          name: form.name,
          description: form.description,
          templateName: form.templateName,
          templateCategory: form.templateCategory,
          templateLanguage: form.templateLanguage,
          variables,
          audience,
          ratePerMinute: Number(form.ratePerMinute) || 20,
          trackLinks: form.trackLinks,
          requiresApproval: form.requiresApproval,
        },
      });
      onSaved(res.data.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const canSave =
    form.name.trim() &&
    form.templateName &&
    (form.audienceType === 'all' || form.segmentId);

  const approved = templates.filter((t) => t.status === 'APPROVED');
  const unapproved = templates.filter((t) => t.status !== 'APPROVED');

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer drawer-wide"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <h2>New campaign</h2>
          <button className="link-danger" onClick={onClose}>
            ✕
          </button>
        </div>

        {loading ? (
          <p className="subtle">Loading templates…</p>
        ) : (
          <>
            {error && <div className="error">{error}</div>}

            <section className="drawer-section">
              <label>
                Name
                <input
                  type="text"
                  value={form.name}
                  placeholder="October Inter G2 push"
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>

              <label>
                Note to yourself (optional)
                <input
                  type="text"
                  value={form.description}
                  placeholder="Why you're sending this"
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </label>
            </section>

            <section className="drawer-section">
              <h3 style={{ marginTop: 0 }}>Message</h3>

              <label>
                Template
                <select
                  value={form.templateName}
                  onChange={(e) => chooseTemplate(e.target.value)}
                >
                  <option value="">Choose an approved template…</option>
                  {approved.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name} ({t.category})
                    </option>
                  ))}
                </select>
              </label>

              {unapproved.length > 0 && (
                <div className="subtle" style={{ marginTop: 6 }}>
                  {unapproved.length} template(s) are not approved and cannot be sent:{' '}
                  {unapproved.map((t) => `${t.name} (${t.status})`).join(', ')}
                </div>
              )}

              {templates.length === 0 && (
                <div className="hint">
                  No templates came back from WATI. You can only send pre-approved
                  templates on WhatsApp — create and get one approved in WATI first.
                </div>
              )}

              {template && (
                <>
                  <label style={{ marginTop: 12 }}>
                    Category (drives the cost estimate)
                    <select
                      value={form.templateCategory}
                      onChange={(e) =>
                        setForm({ ...form, templateCategory: e.target.value })
                      }
                    >
                      {TEMPLATE_CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="subtle">
                    A marketing conversation costs roughly seven times a utility one in
                    India. This is read from WATI — change it only if WATI has it wrong.
                  </div>
                </>
              )}
            </section>

            {template && (template.params || []).length > 0 && (
              <section className="drawer-section">
                <h3 style={{ marginTop: 0 }}>Variables</h3>
                <div className="subtle" style={{ marginBottom: 10 }}>
                  Every placeholder needs a value. A variable left empty renders as a
                  blank in the middle of the sentence on the contact's phone — or gets
                  the whole send rejected.
                </div>

                {template.params.map((p) => {
                  const b = bindings[p] || {};
                  return (
                    <div
                      key={p}
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'end',
                        marginBottom: 10,
                        flexWrap: 'wrap',
                      }}
                    >
                      <label style={{ minWidth: 110 }}>
                        Placeholder
                        <input type="text" value={`{{${p}}}`} disabled />
                      </label>

                      <label style={{ minWidth: 120 }}>
                        Source
                        <select
                          value={b.source || 'static'}
                          onChange={(e) =>
                            setBinding(p, { source: e.target.value, value: '' })
                          }
                        >
                          <option value="static">Same for everyone</option>
                          <option value="attribute">From the contact</option>
                          <option value="link">Tracked link</option>
                        </select>
                      </label>

                      {b.source === 'attribute' ? (
                        <label style={{ flex: 1, minWidth: 150 }}>
                          Field
                          <select
                            value={b.value || ''}
                            onChange={(e) => setBinding(p, { value: e.target.value })}
                          >
                            <option value="">Choose a field…</option>
                            {attributes.map((a) => (
                              <option key={a.field} value={a.field}>
                                {a.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : (
                        <label style={{ flex: 1, minWidth: 180 }}>
                          {b.source === 'link' ? 'URL (will be tracked)' : 'Value'}
                          <input
                            type="text"
                            value={b.value || ''}
                            placeholder={
                              b.source === 'link'
                                ? 'https://focasedu.com/apply'
                                : 'Text every contact sees'
                            }
                            onChange={(e) => setBinding(p, { value: e.target.value })}
                          />
                        </label>
                      )}

                      {b.source === 'attribute' && (
                        <label style={{ minWidth: 120 }}>
                          If missing
                          <input
                            type="text"
                            value={b.fallback || ''}
                            placeholder="there"
                            onChange={(e) => setBinding(p, { fallback: e.target.value })}
                          />
                        </label>
                      )}
                    </div>
                  );
                })}
              </section>
            )}

            <section className="drawer-section">
              <h3 style={{ marginTop: 0 }}>Who gets it</h3>

              <label>
                Audience
                <select
                  value={form.audienceType}
                  onChange={(e) => setForm({ ...form, audienceType: e.target.value })}
                >
                  <option value="segment">A saved audience</option>
                  <option value="all">Everyone contactable</option>
                </select>
              </label>

              {form.audienceType === 'segment' && (
                <label style={{ marginTop: 10 }}>
                  Audience
                  <select
                    value={form.segmentId}
                    onChange={(e) => setForm({ ...form, segmentId: e.target.value })}
                  >
                    <option value="">Choose one…</option>
                    {segments.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.lastCount !== null ? ` (~${s.lastCount})` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {form.audienceType === 'all' && (
                <div className="hint">
                  Everyone in your contact book who hasn't opted out. Check the count on
                  the next screen before you send — this is the button that messages
                  your whole list.
                </div>
              )}

              {segments.length === 0 && form.audienceType === 'segment' && (
                <div className="hint">
                  You have no saved audiences yet. Build one under Audiences, or pick
                  "Everyone contactable".
                </div>
              )}
            </section>

            <section className="drawer-section">
              <h3 style={{ marginTop: 0 }}>Sending</h3>

              <label>
                Messages per minute
                <input
                  type="number"
                  min="1"
                  max="200"
                  value={form.ratePerMinute}
                  onChange={(e) => setForm({ ...form, ratePerMinute: e.target.value })}
                />
              </label>
              <div className="subtle">
                Slow is safe. WhatsApp scores your number on how fast you send and how
                people react — a cold number that fires thousands of marketing templates
                in a couple of minutes gets its quality rating cut, and then nothing
                sends at all.
              </div>

              <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 }}>
                <input
                  type="checkbox"
                  checked={form.trackLinks}
                  style={{ width: 'auto' }}
                  onChange={(e) => setForm({ ...form, trackLinks: e.target.checked })}
                />
                Track link clicks
              </label>
              <div className="subtle">
                Rewrites any URL in the message into a link we host, so we can see who
                tapped it. WhatsApp reports no clicks of its own — turn this off and you
                lose the only real intent signal you get.
              </div>

              <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 }}>
                <input
                  type="checkbox"
                  checked={form.requiresApproval}
                  style={{ width: 'auto' }}
                  onChange={(e) => setForm({ ...form, requiresApproval: e.target.checked })}
                />
                Require an approval before this can send
              </label>
            </section>

            <div className="row-between" style={{ marginTop: 18 }}>
              <button onClick={onClose}>Cancel</button>
              <button type="submit" onClick={save} disabled={!canSave || saving}>
                {saving ? 'Saving…' : 'Save as draft'}
              </button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
