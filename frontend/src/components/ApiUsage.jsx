import { useEffect, useState } from 'react';
import { api } from '../api';

// What the AI providers have cost us, and what is left on each account.
//
// They are billed in different units and only one of them will tell us its balance,
// so the cards deliberately do NOT pretend to be symmetric:
//   ElevenLabs — billed per second of audio; the remaining character quota is read live.
//   Sarvam     — billed per token; it publishes no balance endpoint, so "remaining" only
//                appears when someone has set SARVAM_TOKEN_ALLOWANCE on the server.
//   OpenAI     — billed per token, in arrears, with no balance endpoint at all. Its
//                spend is driven by people asking the Ask tab questions rather than by
//                a worker draining a queue, so it moves in bursts.

function fmtNum(n) {
  return (n || 0).toLocaleString('en-IN');
}

/** Compact token counts — 1.24M reads better than 1,238,412 on a stat card. */
function fmtCompact(n) {
  const v = n || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

function fmtDuration(seconds) {
  const s = Math.round(seconds || 0);
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function barColor(percentUsed) {
  if (percentUsed >= 90) return 'var(--red)';
  if (percentUsed >= 70) return 'var(--amber)';
  return 'var(--green)';
}

/** The headline number for a provider — tokens for Sarvam, audio time for ElevenLabs. */
function spendOf(provider, totals) {
  return provider.unit === 'tokens'
    ? fmtCompact(totals.totalTokens)
    : fmtDuration(totals.audioSeconds);
}

function Balance({ provider }) {
  const { balance } = provider;

  // No balance to show: say why, and what to do about it. Both reasons are fixable
  // by an admin (an API-key permission, or an allowance they have to type in), so
  // this is a hint rather than an error.
  if (!balance?.available) {
    return <div className="hint" style={{ marginBottom: '1rem' }}>{balance?.reason}</div>;
  }

  const isTokens = balance.unit === 'tokens';
  const pct = balance.percentUsed ?? 0;

  return (
    <div className="usage-balance">
      <div>
        <div className="num" style={{ color: barColor(pct) }}>
          {fmtCompact(balance.remaining)}
        </div>
        <div className="label">
          {isTokens ? 'Tokens remaining' : 'Characters remaining'}
        </div>
      </div>

      <div className="usage-balance-meter">
        <div className="rate-wrap" style={{ minWidth: 0 }}>
          <div className="rate-bar">
            <span style={{ width: `${Math.min(100, pct)}%`, background: barColor(pct) }} />
          </div>
          <span className="rate-num">{pct}%</span>
        </div>
        <div className="subtle" style={{ marginTop: '0.4rem' }}>
          {fmtNum(balance.used)} of {fmtNum(balance.limit)} used
          {balance.tier ? ` · ${balance.tier} plan` : ''}
          {balance.resetsAt ? ` · resets ${fmtDate(balance.resetsAt)}` : ''}
          {balance.approximate
            ? ' · counted from this dashboard’s meter, not from Sarvam'
            : ''}
        </div>
      </div>
    </div>
  );
}

function ProviderPanel({ provider }) {
  const { totals, daily } = provider;
  const isTokens = provider.unit === 'tokens';

  return (
    <div className="panel">
      <div className="row-between" style={{ marginBottom: '1rem' }}>
        <div>
          <h2 style={{ margin: 0 }}>{provider.label}</h2>
          <div className="subtle">
            {provider.purpose} · {provider.model}
          </div>
        </div>
        <span className={provider.configured ? 'badge badge-normal' : 'badge badge-low'}>
          {provider.configured ? 'Connected' : 'No API key'}
        </span>
      </div>

      <Balance provider={provider} />

      <div className="summary-grid">
        <div className="card">
          <div className="num">{spendOf(provider, totals.today)}</div>
          <div className="label">Today</div>
        </div>
        <div className="card">
          <div className="num">{spendOf(provider, totals.last7)}</div>
          <div className="label">Last 7 days</div>
        </div>
        <div className="card">
          <div className="num">{spendOf(provider, totals.last30)}</div>
          <div className="label">Last 30 days</div>
        </div>
        <div className="card">
          <div className="num">{spendOf(provider, totals.allTime)}</div>
          <div className="label">Since metering began</div>
        </div>
        <div className="card">
          <div className="num">{fmtNum(totals.allTime.requests)}</div>
          <div className="label">
            Requests{totals.allTime.failures ? ` · ${totals.allTime.failures} failed` : ''}
          </div>
        </div>
      </div>

      <p className="subtle" style={{ marginTop: '-0.4rem', marginBottom: '1rem' }}>
        {/* Only the two pipeline providers have a "work done to date" figure to
            quote. The agent has none — nobody asked it a question before it
            existed — so it simply skips the sentence. */}
        {provider.lifetime
          ? isTokens
            ? `${fmtNum(provider.lifetime.gradedCalls)} calls carry a grade in total. `
            : `${fmtNum(provider.lifetime.transcribedCalls)} calls transcribed in total, ` +
              `${fmtDuration(provider.lifetime.transcribedSeconds)} of audio. `
          : ''}
        The counters above only cover requests made since the usage meter was deployed
        {provider.since ? ` (${provider.since})` : ''}; retries and failed attempts are
        billed too, which is why they are counted here.
      </p>

      <table className="tasks">
        <thead>
          <tr>
            <th>Day</th>
            <th>Requests</th>
            <th>Failed</th>
            {isTokens ? (
              <>
                <th>Input tokens</th>
                <th>Output tokens</th>
                <th>Total tokens</th>
              </>
            ) : (
              <th>Audio transcribed</th>
            )}
          </tr>
        </thead>
        <tbody>
          {[...daily].reverse().map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              <td>{fmtNum(d.requests)}</td>
              <td className={d.failures ? 'cell-overdue' : ''}>{d.failures || 0}</td>
              {isTokens ? (
                <>
                  <td>{fmtNum(d.promptTokens)}</td>
                  <td>{fmtNum(d.completionTokens)}</td>
                  <td>{fmtNum(d.totalTokens)}</td>
                </>
              ) : (
                <td>{fmtDuration(d.audioSeconds)}</td>
              )}
            </tr>
          ))}
          {daily.length === 0 && (
            <tr>
              <td colSpan={isTokens ? 6 : 4} className="subtle">
                Nothing metered yet in this window.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function ApiUsage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);

  async function load(range = days, refresh = false) {
    setLoading(true);
    setError('');
    try {
      setData(await api(`/api/calls/usage?days=${range}${refresh ? '&refresh=1' : ''}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(days);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  if (error) return <div className="error">{error}</div>;
  if (!data) return <p className="subtle">Loading API usage…</p>;

  return (
    <>
      <div className="toolbar">
        <p id="status">AI provider usage and remaining balance</p>
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          {/* refresh=1 bypasses the 5-minute balance cache on the server. */}
          <button onClick={() => load(days, true)} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      <ProviderPanel provider={data.providers.sarvam} />
      <ProviderPanel provider={data.providers.elevenlabs} />
      {/* Added later than the other two, so an older server that doesn't send it
          simply renders nothing here rather than crashing the tab. */}
      {data.providers.openai && <ProviderPanel provider={data.providers.openai} />}
    </>
  );
}
