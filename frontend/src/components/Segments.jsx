import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { relative } from '../campaigns';

/**
 * Saved audiences.
 *
 * A rule is stored as data and compiled on the server, never as a database query —
 * so a segment can be edited and re-counted, and nobody can smuggle arbitrary code
 * into one. The fields and operators offered here come from /api/segments/schema, so
 * this builder physically cannot offer something the compiler will reject.
 */
export default function Segments() {
  const [rows, setRows] = useState([]);
  const [schema, setSchema] = useState(null);
  const [editing, setEditing] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [s, sc] = await Promise.all([api('/api/segments'), api('/api/segments/schema')]);
      setRows(s.data || []);
      setSchema(sc);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (s) => {
    if (!window.confirm(`Delete the audience "${s.name}"?`)) return;
    try {
      await api(`/api/segments/${s.id}`, { method: 'DELETE' });
      setNotice(`"${s.name}" deleted.`);
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <>
      <div className="toolbar">
        <p id="status">
          {rows.length === 0
            ? 'No saved audiences yet.'
            : `${rows.length} saved audience(s)`}
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button
            type="submit"
            onClick={() =>
              setEditing({ name: '', description: '', rule: { match: 'all', conditions: [] } })
            }
          >
            New audience
          </button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <div className="card" style={{ padding: '16px 18px' }}>
        <table className="tasks">
          <thead>
            <tr>
              <th>Audience</th>
              <th>Rule</th>
              <th style={{ textAlign: 'right' }}>Contacts</th>
              <th>Counted</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>
                  <div className="contact-name">{s.name}</div>
                  {s.description && <div className="subtle">{s.description}</div>}
                </td>
                <td className="subtle">{describe(s.rule, schema)}</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>
                  {s.lastCount ?? '—'}
                </td>
                <td className="subtle">
                  {s.lastCountedAt ? relative(s.lastCountedAt) : '—'}
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button onClick={() => setEditing(s)}>Edit</button>{' '}
                  <button className="link-danger" onClick={() => remove(s)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}

            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="subtle">
                  No audiences yet. An audience is a saved rule — "everyone tagged
                  inter-g1 who hasn't been messaged in 30 days" — that you can point a
                  campaign at and re-use.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="subtle" style={{ marginTop: 12 }}>
          {schema?.note}
        </div>
      </div>

      {editing && schema && (
        <SegmentBuilder
          segment={editing}
          schema={schema}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            setNotice(msg);
            load();
          }}
        />
      )}
    </>
  );
}

/** A one-line, human summary of a rule, for the table. */
function describe(rule, schema) {
  const conds = rule?.conditions || [];
  if (!conds.length) return 'Everyone contactable';

  const label = (f) =>
    (schema?.fields || []).find((x) => x.field === f)?.label || f;

  const join = rule.match === 'any' ? ' or ' : ' and ';
  return conds
    .map((c) => {
      if (c.field === 'engagement') return `was "${c.value?.replace(/_/g, ' ')}" in a campaign`;
      return `${label(c.field)} ${c.op.replace(/_/g, ' ')} ${
        Array.isArray(c.value) ? c.value.join(', ') : c.value ?? ''
      }`.trim();
    })
    .join(join);
}

const OP_LABEL = {
  eq: 'is',
  ne: 'is not',
  contains: 'contains',
  in: 'is any of',
  nin: 'is none of',
  exists: 'is set',
  missing: 'is empty',
  gt: 'is more than',
  lt: 'is less than',
  before: 'is before',
  after: 'is after',
  never: 'never happened',
  within_days: 'in the last (days)',
  not_within_days: 'not in the last (days)',
  is: 'was',
  is_not: 'was not',
};

function SegmentBuilder({ segment, schema, onClose, onSaved }) {
  const [name, setName] = useState(segment.name || '');
  const [description, setDescription] = useState(segment.description || '');
  const [match, setMatch] = useState(segment.rule?.match || 'all');
  const [conditions, setConditions] = useState(segment.rule?.conditions || []);
  const [preview, setPreview] = useState(null);
  const [counting, setCounting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const rule = useMemo(() => ({ match, conditions }), [match, conditions]);

  // Live count as the rule changes, debounced. This is the number that stops someone
  // pointing a marketing blast at 40,000 people by accident.
  useEffect(() => {
    const t = setTimeout(async () => {
      setCounting(true);
      try {
        setPreview(await api('/api/segments/preview', { method: 'POST', body: { rule } }));
      } catch (e) {
        setError(e.message);
      } finally {
        setCounting(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [rule]);

  const fieldOf = (f) => (schema.fields || []).find((x) => x.field === f);

  const addCondition = () => {
    const first = schema.fields[0];
    setConditions((c) => [...c, { field: first.field, op: first.ops[0], value: '' }]);
  };

  const setCondition = (i, patch) =>
    setConditions((c) => c.map((x, j) => (i === j ? { ...x, ...patch } : x)));

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      if (segment.id) {
        await api(`/api/segments/${segment.id}`, {
          method: 'PATCH',
          body: { name, description, rule },
        });
      } else {
        await api('/api/segments', { method: 'POST', body: { name, description, rule } });
      }
      onSaved(`"${name}" saved — ${preview?.count ?? 0} contact(s).`);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer drawer-wide" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>{segment.id ? 'Edit audience' : 'New audience'}</h2>
          <button className="link-danger" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="error">{error}</div>}

        <section className="drawer-section">
          <label>
            Name
            <input
              type="text"
              value={name}
              placeholder="Warm but unconverted"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            What this is for (optional)
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
        </section>

        <section className="drawer-section">
          <div className="row-between">
            <h3 style={{ margin: 0 }}>Rules</h3>
            <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              Match
              <select value={match} onChange={(e) => setMatch(e.target.value)}>
                <option value="all">all of these</option>
                <option value="any">any of these</option>
              </select>
            </label>
          </div>

          {conditions.map((c, i) => {
            const f = fieldOf(c.field);
            const isEngagement = c.field === 'engagement';

            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'end',
                  flexWrap: 'wrap',
                  marginTop: 10,
                }}
              >
                <label style={{ minWidth: 170 }}>
                  Field
                  <select
                    value={c.field}
                    onChange={(e) => {
                      const nf = fieldOf(e.target.value);
                      setCondition(i, {
                        field: e.target.value,
                        op: nf.ops[0],
                        value: '',
                        campaignId: undefined,
                      });
                    }}
                  >
                    {schema.fields.map((x) => (
                      <option key={x.field} value={x.field}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label style={{ minWidth: 140 }}>
                  Is
                  <select
                    value={c.op}
                    onChange={(e) => setCondition(i, { op: e.target.value })}
                  >
                    {(f?.ops || []).map((op) => (
                      <option key={op} value={op}>
                        {OP_LABEL[op] || op}
                      </option>
                    ))}
                  </select>
                </label>

                {isEngagement ? (
                  <>
                    <label style={{ flex: 1, minWidth: 160 }}>
                      In campaign
                      <select
                        value={c.campaignId || ''}
                        onChange={(e) => setCondition(i, { campaignId: e.target.value })}
                      >
                        <option value="">Choose…</option>
                        {(f.campaigns || []).map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label style={{ flex: 1, minWidth: 160 }}>
                      State
                      <select
                        value={c.value || ''}
                        onChange={(e) => setCondition(i, { value: e.target.value })}
                      >
                        <option value="">Choose…</option>
                        {(f.states || []).map((s) => (
                          <option key={s.key} value={s.key}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : ['exists', 'missing', 'never'].includes(c.op) ? null : f?.options ? (
                  <label style={{ flex: 1, minWidth: 160 }}>
                    Value
                    <select
                      value={Array.isArray(c.value) ? c.value[0] || '' : c.value || ''}
                      onChange={(e) =>
                        setCondition(i, {
                          value: ['in', 'nin'].includes(c.op)
                            ? [e.target.value]
                            : e.target.value,
                        })
                      }
                    >
                      <option value="">Choose…</option>
                      {f.options.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label style={{ flex: 1, minWidth: 160 }}>
                    Value
                    <input
                      type={
                        f?.type === 'date' && ['before', 'after'].includes(c.op)
                          ? 'date'
                          : f?.type === 'number' || c.op?.includes('days')
                            ? 'number'
                            : 'text'
                      }
                      value={c.value ?? ''}
                      onChange={(e) => setCondition(i, { value: e.target.value })}
                    />
                  </label>
                )}

                <button
                  className="link-danger"
                  onClick={() => setConditions((cs) => cs.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
            );
          })}

          <button onClick={addCondition} style={{ marginTop: 12 }}>
            Add a rule
          </button>

          {conditions.length === 0 && (
            <div className="hint" style={{ marginTop: 10 }}>
              With no rules, this audience is <strong>everyone contactable</strong>. That
              is a real option — just be sure you meant it.
            </div>
          )}
        </section>

        <section className="drawer-section">
          <div className="row-between">
            <h3 style={{ margin: 0 }}>
              {counting ? 'Counting…' : `${preview?.count ?? 0} contact(s) match`}
            </h3>
            {preview?.excluded > 0 && (
              <span className="subtle">
                {preview.excluded} more match but have opted out or are unreachable —
                they are excluded, always.
              </span>
            )}
          </div>

          {preview?.sample?.length > 0 && (
            <div className="subtle" style={{ marginTop: 8 }}>
              For example: {preview.sample.slice(0, 6).map((s) => s.name || s.phone).join(', ')}
            </div>
          )}
        </section>

        <div className="row-between" style={{ marginTop: 18 }}>
          <button onClick={onClose}>Cancel</button>
          <button type="submit" onClick={save} disabled={!name.trim() || saving}>
            {saving ? 'Saving…' : 'Save audience'}
          </button>
        </div>
      </aside>
    </div>
  );
}
