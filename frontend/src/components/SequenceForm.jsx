import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Build a drip off a finished campaign.
 *
 * Every step is aimed at a funnel state of the PARENT, and the delay is measured from
 * when the parent finished sending — not from the previous step. If the delays chained,
 * a slow step 1 would push step 2 late and step 3 later still, and a "day 5" message
 * that lands on day 8 is a different message.
 */
export default function SequenceForm({ campaign, funnel, onSaved }) {
  const [templates, setTemplates] = useState([]);
  const [name, setName] = useState(`${campaign.name} follow-up`);
  const [steps, setSteps] = useState([
    { delayHours: 48, templateName: '', audience: 'delivered_not_read' },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/campaigns/templates')
      .then((t) => setTemplates((t.data || []).filter((x) => x.status === 'APPROVED')))
      .catch((e) => setError(e.message));
  }, []);

  const chaseable = (funnel || []).filter((f) => f.retargetable);

  const setStep = (i, patch) =>
    setSteps((s) => s.map((step, j) => (i === j ? { ...step, ...patch } : step)));

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const json = await api('/api/sequences', {
        method: 'POST',
        body: {
          name,
          parentCampaignId: campaign.id,
          steps: steps.map((s) => {
            const t = templates.find((x) => x.name === s.templateName);
            return {
              delayHours: Number(s.delayHours) || 48,
              templateName: s.templateName,
              templateCategory: (t && t.category) || 'MARKETING',
              templateLanguage: (t && t.language) || '',
              audience: s.audience,
              variables: [],
            };
          }),
        },
      });
      onSaved(json.message || 'Drip saved.');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const valid = name.trim() && steps.every((s) => s.templateName && s.audience);

  return (
    <div style={{ marginTop: 12 }}>
      {error && <div className="error">{error}</div>}

      <label>
        Name
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      {steps.map((step, i) => {
        const target = chaseable.find((f) => f.key === step.audience);
        return (
          <div
            key={i}
            className="card"
            style={{ padding: 12, marginTop: 10, background: 'var(--surface-inset)' }}
          >
            <div className="row-between">
              <strong>Step {i + 1}</strong>
              {steps.length > 1 && (
                <button
                  className="link-danger"
                  onClick={() => setSteps((s) => s.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <label style={{ minWidth: 110 }}>
                Wait (hours)
                <input
                  type="number"
                  min="1"
                  value={step.delayHours}
                  onChange={(e) => setStep(i, { delayHours: e.target.value })}
                />
              </label>

              <label style={{ flex: 1, minWidth: 180 }}>
                Chase whoever was
                <select
                  value={step.audience}
                  onChange={(e) => setStep(i, { audience: e.target.value })}
                >
                  {chaseable.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label} ({f.count} right now)
                    </option>
                  ))}
                </select>
              </label>

              <label style={{ flex: 1, minWidth: 180 }}>
                With this template
                <select
                  value={step.templateName}
                  onChange={(e) => setStep(i, { templateName: e.target.value })}
                >
                  <option value="">Choose one…</option>
                  {templates.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name} ({t.category})
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {step.templateName === campaign.templateName && (
              <div className="hint" style={{ marginTop: 8 }}>
                That's the same template the campaign already sent them. Re-sending an
                identical message to someone who ignored it once is a nag, not a
                follow-up — change the hook.
              </div>
            )}

            {target && (
              <div className="subtle" style={{ marginTop: 6 }}>
                {target.hint}
              </div>
            )}
          </div>
        );
      })}

      <div className="row-between" style={{ marginTop: 12 }}>
        <button
          onClick={() =>
            setSteps((s) => [
              ...s,
              {
                delayHours: (s[s.length - 1]?.delayHours || 48) + 72,
                templateName: '',
                audience: 'read_no_click',
              },
            ])
          }
        >
          Add a step
        </button>
        <button type="submit" onClick={save} disabled={!valid || saving}>
          {saving ? 'Saving…' : 'Start the drip'}
        </button>
      </div>

      <div className="subtle" style={{ marginTop: 8 }}>
        Steps fire from when this campaign finished sending, and each one becomes a real
        campaign you can open and inspect. Opt-outs are honoured at the moment of
        sending, not when the step was planned.
      </div>
    </div>
  );
}
