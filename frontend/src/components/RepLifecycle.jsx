import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { openLead } from '../route';
import DateRangeBar from './DateRangeBar';
import PageHeader from './ui/PageHeader';
import Section from './ui/Section';
import DataTable from './ui/DataTable';
import FilterBar from './ui/FilterBar';
import StatCard, { StatGrid } from './ui/StatCard';
import EmptyState from './ui/EmptyState';
import Icon from './ui/Icon';
import { formatCount, formatDay, formatPct, formatRupees, localIso } from '../adStats';

// The Rep Lifecycle tab: what happens between a lead arriving and its first
// call, for one rep's leads, split by how they ended (won / lost / junk / open).
// Renders GET /api/calls/rep-lifecycle verbatim — see services/repLifecycle for
// which leads count, what lead-in means, and how dials and connects are told apart.

// Opens on Veera, the rep this view was built to study.
const DEFAULT_OWNER = 'veera.focasedu@gmail.com';

const OUTCOMES = [
  { key: 'won', label: 'Closed with sale', tone: 'green' },
  { key: 'lost', label: 'Closed without sale', tone: 'red' },
  { key: 'junk', label: 'Junk', tone: 'muted' },
  { key: 'open', label: 'Open', tone: 'amber' },
];
const OUTCOME_LABEL = Object.fromEntries(OUTCOMES.map((o) => [o.key, o.label]));

const SIGNALS = [
  { key: 'speed', title: 'Speed to first dial', meta: 'Lead-in to the first outbound call' },
  { key: 'attempts', title: 'Dials to connect', meta: 'Outbound dials up to the first call with talk time' },
  { key: 'slot', title: 'Lead-in time of day', meta: 'IST, when the lead arrived' },
  { key: 'weekday', title: 'Lead-in weekday', meta: 'IST' },
  { key: 'whatsapp', title: 'WhatsApp before first call', meta: 'A template sent from the dashboard after lead-in, before the first dial' },
  { key: 'templates', title: 'Which WhatsApp template went first', meta: 'Leads with a WhatsApp before the first call' },
  { key: 'firstCaller', title: 'Who made the first dial', meta: 'Every call on the lead counts, whoever made it' },
];

// Smallest bucket whose win % gets highlighted, so 1 sale from 1 lead doesn't
// read as the best bucket.
const MIN_LEADS_FOR_BEST = 10;

function last90() {
  const d = new Date();
  d.setDate(d.getDate() - 89);
  return { label: 'Last 90 days', from: localIso(d), to: localIso(new Date()) };
}

function formatMins(m) {
  if (m == null) return '—';
  if (m < 60) return `${Math.round(m)} min`;
  if (m < 24 * 60) return `${(m / 60).toFixed(1)} hr`;
  return `${(m / 1440).toFixed(1)} days`;
}

const formatTime = (v) =>
  v
    ? new Date(v).toLocaleString('en-IN', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

function SignalTable({ rows }) {
  const best = rows
    .filter((r) => r.leads >= MIN_LEADS_FOR_BEST && r.winPct != null)
    .reduce((a, r) => (!a || r.winPct > a.winPct ? r : a), null);
  return (
    <DataTable>
      <thead>
        <tr>
          <th>Bucket</th>
          <th className="num">Leads</th>
          <th className="num">Won</th>
          <th className="num">Lost</th>
          <th className="num">Junk</th>
          <th className="num">Open</th>
          <th className="num">Win %</th>
          <th className="num">Revenue</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{r.label}</td>
            <td className="num">{formatCount(r.leads)}</td>
            <td className="num">{formatCount(r.won)}</td>
            <td className="num">{formatCount(r.lost)}</td>
            <td className="num">{formatCount(r.junk)}</td>
            <td className="num">{formatCount(r.open)}</td>
            <td className="num">{best && best.key === r.key ? <b>{formatPct(r.winPct)}</b> : formatPct(r.winPct)}</td>
            <td className="num">{formatRupees(r.revenue)}</td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

export default function RepLifecycle() {
  const [range, setRange] = useState(last90);
  const [owners, setOwners] = useState([]);
  const [owner, setOwner] = useState(DEFAULT_OWNER);
  const [outcome, setOutcome] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api('/api/calls/rep-lifecycle/owners')
      .then((res) => setOwners(res.owners || []))
      .catch((err) => setError(err.message));
  }, []);

  const load = useCallback(async (o, r) => {
    setLoading(true);
    try {
      const qs = `owner=${encodeURIComponent(o)}&from=${r.from}&to=${r.to}`;
      setData(await api(`/api/calls/rep-lifecycle?${qs}`));
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(owner, range);
  }, [load, owner, range]);

  const preset = last90();
  const extra = [
    {
      label: preset.label,
      active: range.from === preset.from && range.to === preset.to,
      onSelect: () => setRange(preset),
    },
  ];

  const leads = useMemo(
    () => ((data && data.leads) || []).filter((l) => !outcome || l.outcome === outcome),
    [data, outcome]
  );

  const s = data && data.summary;

  return (
    <>
      <PageHeader
        actions={
          <DateRangeBar range={range} onChange={setRange} extra={extra}>
            <button onClick={() => load(owner, range)} disabled={loading}>
              <Icon name="refresh" size={14} />
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </DateRangeBar>
        }
      />

      <FilterBar>
        <label>
          Rep
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            {!owners.some((o) => o.email === owner) && <option value={owner}>{owner}</option>}
            {owners.map((o) => (
              <option key={o.email} value={o.email}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      </FilterBar>

      {error && <div className="error">{error}</div>}
      {!data && !error && <p className="subtle">Loading lifecycle…</p>}

      {data && (
        <>
          <div className="mkt-kpis">
            <StatGrid>
              <StatCard label="Leads" value={formatCount(s.all.leads)} hint={`Median ${formatMins(s.all.medianMinsToDial)} to first dial`} />
              {OUTCOMES.map((o) => (
                <StatCard
                  key={o.key}
                  label={o.label}
                  tone={o.tone}
                  value={formatCount(s[o.key].leads)}
                  hint={`Dial ${formatMins(s[o.key].medianMinsToDial)} · connect ${formatMins(s[o.key].medianMinsToConnect)}`}
                />
              ))}
            </StatGrid>
          </div>

          <Section title="Won vs lost — before the first call" meta={`Leads in ${formatDay(range.from)} – ${formatDay(range.to)}`} flush>
            <DataTable>
              <thead>
                <tr>
                  <th>Outcome</th>
                  <th className="num">Leads</th>
                  <th className="num">Median to first dial</th>
                  <th className="num">Median to connect</th>
                  <th className="num">Median dials to connect</th>
                  <th className="num">Never called</th>
                  <th className="num">WhatsApp first</th>
                  <th className="num">First dial by another rep</th>
                  <th className="num">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {[...OUTCOMES, { key: 'all', label: 'All leads' }].map((o) => {
                  const x = s[o.key];
                  return (
                    <tr key={o.key}>
                      <td>{o.key === 'all' ? <b>{o.label}</b> : o.label}</td>
                      <td className="num">{formatCount(x.leads)}</td>
                      <td className="num">{formatMins(x.medianMinsToDial)}</td>
                      <td className="num">{formatMins(x.medianMinsToConnect)}</td>
                      <td className="num">{x.medianAttempts == null ? '—' : x.medianAttempts}</td>
                      <td className="num">{formatPct(x.neverCalledPct)}</td>
                      <td className="num">{formatPct(x.whatsappFirstPct)}</td>
                      <td className="num">{formatPct(x.firstCallByOtherPct)}</td>
                      <td className="num">{formatRupees(x.revenue)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          </Section>

          {SIGNALS.map((sig) => {
            const rows = data.signals[sig.key] || [];
            if (sig.key === 'templates' && rows.length === 0) return null;
            return (
              <Section key={sig.key} title={sig.title} meta={sig.meta} flush>
                <SignalTable rows={rows} />
              </Section>
            );
          })}

          <Section
            title="Leads"
            meta={`${formatCount(leads.length)} leads, newest first. Click one to open its timeline.`}
            actions={
              <select value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="Outcome">
                <option value="">All outcomes</option>
                {OUTCOMES.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            }
            flush={leads.length > 0}
          >
            {leads.length === 0 ? (
              <EmptyState title="No leads for this rep in this range">Try a wider window.</EmptyState>
            ) : (
              <DataTable className="mkt-wide">
                <thead>
                  <tr>
                    <th>Lead</th>
                    <th>Lead in</th>
                    <th className="num">To first dial</th>
                    <th className="num">To connect</th>
                    <th className="num">Dials</th>
                    <th>First dial by</th>
                    <th>WhatsApp first</th>
                    <th className="num">Calls</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.map((l) => (
                    <tr
                      key={l.contactId}
                      className={l.phoneKey ? 'clickable-row' : undefined}
                      onClick={l.phoneKey ? () => openLead(l.phoneKey) : undefined}
                    >
                      <td>
                        <span className="who">{l.name || l.phoneKey || l.contactId}</span>
                      </td>
                      <td title={l.leadInSource === 'form' ? 'Form fill' : 'Bigin created'}>{formatTime(l.leadInAt)}</td>
                      <td className="num">{formatMins(l.minsToDial)}</td>
                      <td className="num">
                        {formatMins(l.minsToConnect)}
                        {l.connectedBy === 'callIn' && <span className="subtle"> (called in)</span>}
                      </td>
                      <td className="num">{l.firstConnectAt ? l.attempts : `${l.attempts} ✕`}</td>
                      <td>{l.firstCallBy || '—'}</td>
                      <td>{l.whatsappFirst || '—'}</td>
                      <td className="num">{formatCount(l.totalCalls)}</td>
                      <td title={l.lostReason || l.stage || ''}>
                        {OUTCOME_LABEL[l.outcome]}
                        {l.outcome === 'won' && ` · ${formatRupees(l.amount)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
            <p className="subtle mkt-note">
              Leads are Bigin contacts this rep owns, plus contacts whose won deal they own, picked by lead-in
              date. Lead-in is the earliest form fill in the week before Bigin created the contact, else Bigin's
              created time. A dial is any outbound call, and a connect is the first call with talk time. Junk is a lost deal
              with a junk reason. Test numbers and the office DID are excluded.
            </p>
          </Section>
        </>
      )}
    </>
  );
}
