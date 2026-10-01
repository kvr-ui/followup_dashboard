import { useEffect, useState } from 'react';
import { api } from '../api';
import PageHeader from './ui/PageHeader';
import Section from './ui/Section';
import DataTable from './ui/DataTable';
import StatCard, { StatGrid } from './ui/StatCard';
import Icon from './ui/Icon';

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

function barTone(percentUsed) {
  if (percentUsed >= 90) return 'red';
  if (percentUsed >= 70) return 'amber';
  return 'green';
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
    return <div className="hint usage-reason">{balance?.reason}</div>;
  }

  const isTokens = balance.unit === 'tokens';
  const pct = balance.percentUsed ?? 0;
  const tone = barTone(pct);

  return (
    <div className="usage-balance">
      <div>
        <div className={`usage-figure usage-${tone}`}>{fmtCompact(balance.remaining)}</div>
        <div className="usage-label">
          {isTokens ? 'Tokens remaining' : 'Characters remaining'}
        </div>
      </div>

      <div>
        <div className="usage-meter">
          <div className="usage-track">
            <span
              className={`usage-fill usage-fill-${tone}`}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
          <span className="usage-pct">{pct}%</span>
        </div>
        <div className="subtle usage-detail">
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
    <Section
      title={provider.label}
      meta={`${provider.purpose} · ${provider.model}`}
      actions={
        <span className={provider.configured ? 'badge badge-normal' : 'badge badge-low'}>
          {provider.configured ? 'Connected' : 'No API key'}
        </span>
      }
    >
      <Balance provider={provider} />

      <StatGrid>
        <StatCard label="Today" value={spendOf(provider, totals.today)} />
        <StatCard label="Last 7 days" value={spendOf(provider, totals.last7)} />
        <StatCard label="Last 30 days" value={spendOf(provider, totals.last30)} />
        <StatCard label="Since metering began" value={spendOf(provider, totals.allTime)} />
        <StatCard
          label={`Requests${totals.allTime.failures ? ` · ${totals.allTime.failures} failed` : ''}`}
          value={fmtNum(totals.allTime.requests)}
        />
      </StatGrid>

      <p className="subtle usage-note">
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

      <DataTable>
        <thead>
          <tr>
            <th>Day</th>
            <th className="num">Requests</th>
            <th className="num">Failed</th>
            {isTokens ? (
              <>
                <th className="num">Input tokens</th>
                <th className="num">Output tokens</th>
                <th className="num">Total tokens</th>
              </>
            ) : (
              <th className="num">Audio transcribed</th>
            )}
          </tr>
        </thead>
        <tbody>
          {[...daily].reverse().map((d) => (
            <tr key={d.day}>
              <td>{d.day}</td>
              <td className="num">{fmtNum(d.requests)}</td>
              <td className={d.failures ? 'num cell-overdue' : 'num'}>{d.failures || 0}</td>
              {isTokens ? (
                <>
                  <td className="num">{fmtNum(d.promptTokens)}</td>
                  <td className="num">{fmtNum(d.completionTokens)}</td>
                  <td className="num">{fmtNum(d.totalTokens)}</td>
                </>
              ) : (
                <td className="num">{fmtDuration(d.audioSeconds)}</td>
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
      </DataTable>
    </Section>
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
      <PageHeader
        meta={<span id="status">AI provider usage and remaining balance</span>}
        actions={
          <>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
            {/* refresh=1 bypasses the 5-minute balance cache on the server. */}
            <button onClick={() => load(days, true)} disabled={loading}>
              <Icon name="refresh" size={14} />
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </>
        }
      />

      <ProviderPanel provider={data.providers.sarvam} />
      <ProviderPanel provider={data.providers.elevenlabs} />
      {/* Added later than the other two, so an older server that doesn't send it
          simply renders nothing here rather than crashing the tab. */}
      {data.providers.openai && <ProviderPanel provider={data.providers.openai} />}
    </>
  );
}
