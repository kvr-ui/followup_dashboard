import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { pct } from '../campaigns';

/**
 * Is the WhatsApp number in trouble?
 *
 * The boring page nobody opens until the day nothing sends. Worth having, because
 * WhatsApp's enforcement is silent: Meta cuts a number's quality rating based on
 * blocks and reports, slashes its daily limit, and the first you hear about it is
 * campaigns failing.
 */
export default function CampaignHealth() {
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setRes(await api('/api/campaigns/health'));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!res && !error) return <p className="subtle">Checking…</p>;

  const m = res?.metrics || {};
  const verdictColor =
    res?.verdict === 'bad'
      ? 'var(--red)'
      : res?.verdict === 'warn'
        ? 'var(--amber)'
        : 'var(--green)';
  const verdictText =
    res?.verdict === 'bad'
      ? 'Needs attention'
      : res?.verdict === 'warn'
        ? 'Worth a look'
        : 'Healthy';

  return (
    <>
      {error && <div className="error">{error}</div>}

      <div className="summary-grid">
        <div className="card">
          <div className="num" style={{ color: verdictColor }}>
            {verdictText}
          </div>
          <div className="label">Last {res?.windowDays} days</div>
        </div>
        <div className="card">
          <div className="num">{pct(m.deliveryRate)}</div>
          <div className="label">Delivered</div>
        </div>
        <div className="card">
          <div
            className="num"
            style={{ color: m.failureRate >= 5 ? 'var(--red)' : 'inherit' }}
          >
            {pct(m.failureRate)}
          </div>
          <div className="label">Failed</div>
        </div>
        <div className="card">
          <div
            className="num"
            style={{ color: m.optOutRate >= 1 ? 'var(--red)' : 'inherit' }}
          >
            {pct(m.optOutRate)}
          </div>
          <div className="label">Opted out</div>
        </div>
        <div className="card">
          <div className="num">{m.contactable ?? 0}</div>
          <div className="label">Contactable</div>
        </div>
      </div>

      <div className="toolbar">
        <p id="status">
          {res?.warnings?.length
            ? `${res.warnings.length} thing(s) to look at`
            : 'Nothing looks wrong.'}
        </p>
        <button onClick={load} disabled={loading}>
          {loading ? 'Checking…' : 'Re-check'}
        </button>
      </div>

      {res?.warnings?.map((w, i) => (
        <div key={i} className={w.level === 'bad' ? 'error' : 'hint'}>
          <strong>{w.title}</strong>
          <div>{w.detail}</div>
        </div>
      ))}

      <div className="panel" style={{ marginTop: 18 }}>
        <h2>Templates</h2>
        <div className="mini-grid">
          <div className="panel-sm">
            <h3>Approved</h3>
            <div className="num" style={{ fontSize: '1.4rem', color: 'var(--green)' }}>
              {res?.templates?.approved ?? 0}
            </div>
          </div>
          <div className="panel-sm">
            <h3>Pending</h3>
            <div className="num" style={{ fontSize: '1.4rem' }}>
              {res?.templates?.pending ?? 0}
            </div>
          </div>
          <div className="panel-sm">
            <h3>Rejected</h3>
            <div
              className="num"
              style={{
                fontSize: '1.4rem',
                color: res?.templates?.rejected ? 'var(--red)' : 'inherit',
              }}
            >
              {res?.templates?.rejected ?? 0}
            </div>
          </div>
        </div>

        {!res?.templatesReadable && (
          <div className="hint" style={{ marginTop: 12 }}>
            WATI didn't answer, so template statuses could not be checked. That is
            itself worth knowing — a scheduled campaign whose template got rejected
            overnight will fail on every single message.
          </div>
        )}
      </div>

      <div className="subtle" style={{ marginTop: 16 }}>
        {res?.caveat}
      </div>
    </>
  );
}
