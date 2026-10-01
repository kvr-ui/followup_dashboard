import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import { statusClass } from '../utils';
import { leaveLead } from '../leadRoute';
import { LEAD_STATUS } from '../adStats';
import { rupees } from '../money';
import { upsoldTo } from '../upsell';
import CopyButton from './CopyButton';
import TaskActions, { taskBody } from './TaskActions';
import Acquisition from './Acquisition';
import VslWatch from './VslWatch';
import CallDetail from './CallDetail';
import { Field, value } from './Field';
import { ts, useRecordingUrl } from './callParts';

// One page per lead at #/lead/<phoneKey>, built from GET /api/lead-profile/:phoneKey.
//
// Left: what you can DO — status, note, WhatsApp — always against the newest Task.
// Right: one tab per section that has data — timeline, deals, calls, forms… —
// showing that section alone.
// Older Tasks are read-only; their notes already sit in the timeline.

const SOURCE_LABELS = { meta: 'Meta', web: 'Web' };

const TIMELINE_LABELS = {
  form: 'Form',
  task: 'Follow-up',
  status: 'Status',
  note: 'Note',
  whatsapp: 'WhatsApp',
  call: 'Call',
  deal: 'Deal',
};

const DEAL_OUTCOME = {
  won: { label: 'Won', cls: 'status-won' },
  lost: { label: 'Lost', cls: 'status-lost' },
  open: { label: 'Open', cls: 'status-pipeline' },
};

export default function LeadProfile({ phoneKey }) {
  const [data, setData] = useState(null);
  const [zohoSync, setZohoSync] = useState(true);
  const [error, setError] = useState(null); // { status, message }
  const [loading, setLoading] = useState(true);
  const [openCallId, setOpenCallId] = useState(null);
  // Which section tab is open. Back to the timeline whenever another lead opens.
  const [tab, setTab] = useState('timeline');
  useEffect(() => setTab('timeline'), [phoneKey]);

  // On a laptop the page itself stays still and only the open tab scrolls, so
  // the page is sized to the window below wherever it starts (the app header
  // above it wraps to a different height at different widths).
  const pageRef = useRef(null);
  const hasData = Boolean(data);
  useLayoutEffect(() => {
    const el = pageRef.current;
    if (!el) return undefined;
    const place = () =>
      el.style.setProperty('--lp-offset', `${el.getBoundingClientRect().top + window.scrollY}px`);
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [hasData]);
  // Only the newest request may land — a slow refetch must not overwrite a newer lead.
  const seq = useRef(0);

  const load = useCallback(
    async (fresh) => {
      const mine = ++seq.current;
      if (fresh) {
        setData(null);
        setLoading(true);
      }
      setError(null);
      try {
        const res = await api(`/api/lead-profile/${encodeURIComponent(phoneKey)}`);
        if (mine !== seq.current) return;
        setData(res.data);
        setZohoSync(res.zohoSync !== false);
      } catch (err) {
        if (mine !== seq.current) return;
        setError({ status: err.status || 0, message: err.message });
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [phoneKey]
  );

  useEffect(() => {
    setOpenCallId(null);
    window.scrollTo(0, 0);
    load(true);
  }, [load]);

  const refetch = useCallback(() => load(false), [load]);

  if (!data) {
    if (loading) {
      return (
        <div className="lead-profile">
          <BackLink />
          <p className="subtle" style={{ marginTop: '1rem' }}>
            Loading lead…
          </p>
        </div>
      );
    }
    return <ProfileError error={error} onRetry={() => load(true)} />;
  }

  const { header = {}, latestTask, olderTasks = [], webLeads = [], metaLeads = [] } = data;
  const deals = data.deals || [];
  const calls = data.calls || [];
  const timeline = data.timeline || [];
  const hasForms = webLeads.length > 0 || metaLeads.length > 0;

  // One tab per section that has data, in reading order. Clicking a tab shows
  // that section alone; the count sits on the tab instead of in a heading.
  const sections = [
    timeline.length > 0 && {
      id: 'timeline',
      label: 'Timeline',
      count: timeline.length,
      render: () => <Timeline events={timeline} />,
    },
    deals.length > 0 && {
      id: 'deals',
      label: 'Deals',
      count: deals.length,
      render: () => <Deals deals={deals} />,
    },
    calls.length > 0 && {
      id: 'calls',
      label: 'Calls',
      count: calls.length,
      render: () => <Calls calls={calls} onOpen={setOpenCallId} />,
    },
    // Always shown: "never watched" and "VSL not connected" are both answers.
    {
      id: 'vsl',
      label: 'VSL watch time',
      render: () =>
        data.vsl ? <VslWatch vsl={data.vsl} /> : <VslEmpty configured={data.vslConfigured !== false} />,
    },
    hasForms && {
      id: 'forms',
      label: 'Form answers',
      count: webLeads.length + metaLeads.length,
      render: () => <FormAnswers webLeads={webLeads} metaLeads={metaLeads} />,
    },
    data.acquisition && {
      id: 'acquisition',
      label: 'Acquisition',
      render: () => <Acquisition acq={data.acquisition} />,
    },
    olderTasks.length > 0 && {
      id: 'older',
      label: 'Older follow-ups',
      count: olderTasks.length,
      render: () => <OlderTasks tasks={olderTasks} />,
    },
  ].filter(Boolean);
  // A lead with no timeline (or a tab that just emptied) falls back to the first.
  const active = sections.find((sec) => sec.id === tab) || sections[0] || null;

  return (
    <div className="lead-profile lp-fit" ref={pageRef}>
      <ProfileHeader
        header={header}
        phoneKey={phoneKey}
        stats={{
          followUps: (latestTask ? 1 : 0) + olderTasks.length,
          calls: calls.length,
          deals: deals.length,
          forms: webLeads.length + metaLeads.length,
          lastActivity: timeline[0]?.at || null,
          avgScore: averageScore(calls),
        }}
      />

      {/* A refetch after an action failed: keep the page, say so. */}
      {error && (
        <div className="error">
          {error.message}{' '}
          <button className="link-btn" onClick={refetch}>
            Retry
          </button>
        </div>
      )}

      {/* Actions pinned on the left; the sections, one tab at a time, on the right. */}
      <div className={latestTask ? 'lp-layout' : 'lp-layout lp-no-actions'}>
        {latestTask && (
          <aside className="lp-actions">
            <TaskActions
              key={latestTask.id}
              task={latestTask}
              zohoSync={zohoSync}
              onChanged={refetch}
            />
          </aside>
        )}

        <div className="lp-main">
          {active ? (
            <>
              <nav className="lp-tabs" role="tablist">
                {sections.map((sec) => (
                  <button
                    key={sec.id}
                    role="tab"
                    aria-selected={sec.id === active.id}
                    className={sec.id === active.id ? 'lp-tab active' : 'lp-tab'}
                    onClick={() => setTab(sec.id)}
                  >
                    {sec.label}
                    {sec.count != null && <span className="lp-tab-count">{sec.count}</span>}
                  </button>
                ))}
              </nav>
              <div className="lp-panel" role="tabpanel">
                {active.render()}
              </div>
            </>
          ) : (
            <p className="subtle">Nothing recorded for this lead yet.</p>
          )}
        </div>
      </div>

      {openCallId && <CallDetail callId={openCallId} onClose={() => setOpenCallId(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header, back, error states
// ---------------------------------------------------------------------------

/** "25 Sep 2026, 2:01 pm" — the page's one date format. */
function shortDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d
    .toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`;
}

function BackLink() {
  return (
    <a
      href="#"
      className="lp-back"
      onClick={(e) => {
        e.preventDefault();
        leaveLead();
      }}
    >
      ← Back
    </a>
  );
}

function ProfileHeader({ header, phoneKey, stats }) {
  const phone = header.phone || phoneKey;
  const state = LEAD_STATUS[header.state] ? header.state : 'none';
  const source = header.leadSource;
  const sourceLabel = SOURCE_LABELS[source];
  const counts = [
    ['Follow-ups', stats.followUps],
    ['Calls', stats.calls],
    ['Deals', stats.deals],
    ['Forms', stats.forms],
    ['Call score', stats.avgScore == null ? '—' : stats.avgScore],
  ];

  return (
    <div className="lp-header">
      <div className="lp-hero">
        <div className="lp-header-main">
          <div className="lp-title-row">
            <BackLink />
            <h2 className="lp-name">{header.name || 'Unnamed lead'}</h2>
          </div>
          <div className="lp-header-meta">
            <span className="phone-row">
              <a href={`tel:${phone}`}>{phone}</a>
              <CopyButton text={String(phone)} title="Copy phone number" />
            </span>
            {source &&
              (sourceLabel ? (
                <span className={`badge source-badge source-${source}`}>{sourceLabel}</span>
              ) : (
                <span className="badge badge-normal" title="Lead source">
                  {source}
                </span>
              ))}
            <span className={statusClass(state)} title={LEAD_STATUS[state].hint}>
              {LEAD_STATUS[state].label}
            </span>
            {(header.ownerName || header.ownerEmail) && (
              <span className="lp-owner" title={header.ownerEmail || undefined}>
                <span className="subtle">Owner</span> {header.ownerName || header.ownerEmail}
              </span>
            )}
          </div>
        </div>
        <dl className="lp-stats">
          {counts.map(([label, n]) => (
            <div key={label} className="lp-stat">
              <dt>{label}</dt>
              <dd>{n}</dd>
            </div>
          ))}
          <div className="lp-stat lp-stat-wide">
            <dt>Last activity</dt>
            <dd>{shortDateTime(stats.lastActivity)}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function ProfileError({ error, onRetry }) {
  const status = error?.status;
  let title;
  let body;
  let retry = false;
  if (status === 403) {
    title = 'Not your lead';
    body = 'This lead belongs to another rep — you have no follow-up, deal or call on it.';
  } else if (status === 404 || status === 400) {
    title = 'No lead found for this number';
    body = 'Nothing in follow-ups, ad leads, deals or calls matches this phone number.';
  } else {
    title = 'Could not load this lead';
    body = error?.message || 'Something went wrong.';
    retry = true;
  }
  return (
    <div className="lead-profile">
      <BackLink />
      <div className="drawer-section lp-empty">
        <h2 className="lp-name">{title}</h2>
        <p className="subtle">{body}</p>
        <div className="lp-empty-actions">
          <button onClick={leaveLead}>← Back</button>
          {retry && <button onClick={onRetry}>Retry</button>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Timeline
// ---------------------------------------------------------------------------

const TIME_FMT = { hour: 'numeric', minute: '2-digit' };

/** "Today", "Yesterday", "25 Sep" — or "25 Sep 2025" outside this year. */
function dayLabel(date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return day.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    ...(day.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

function Timeline({ events }) {
  const [type, setType] = useState('all');
  // Only the types this lead actually has, in the label order.
  const types = Object.keys(TIMELINE_LABELS).filter((t) => events.some((e) => e.type === t));
  const shown = type === 'all' ? events : events.filter((e) => e.type === type);

  // Events arrive newest first; group consecutive ones under a day heading.
  const days = [];
  for (const ev of shown) {
    const label = dayLabel(ev.at);
    const last = days[days.length - 1];
    if (last && last.label === label) last.events.push(ev);
    else days.push({ label, events: [ev] });
  }

  return (
    <section className="drawer-section lp-timeline-card">
      <div className="lp-timeline-head">
        <span className="field-label">Timeline</span>
        <span className="subtle">{shown.length}</span>
      </div>
      {types.length > 1 && (
        <div className="lp-chips">
          {['all', ...types].map((t) => (
            <button
              key={t}
              className={type === t ? 'lp-chip active' : 'lp-chip'}
              onClick={() => setType(t)}
            >
              {t === 'all' ? 'All' : TIMELINE_LABELS[t]}
            </button>
          ))}
        </div>
      )}
      <div className="lp-timeline-scroll">
        {days.map((day) => (
          <div key={day.label} className="lp-day">
            <div className="lp-day-label">{day.label}</div>
            <ul className="lp-timeline">
              {day.events.map((ev, i) => (
                <li key={`${ev.at}-${i}`} className={`lp-ev lp-ev-${ev.type}`}>
                  <span className={`badge lp-type lp-type-${ev.type}`}>
                    {TIMELINE_LABELS[ev.type] || ev.type}
                  </span>
                  <div className="lp-ev-body">
                    <div className="lp-ev-text">{ev.text}</div>
                    <div className="lp-ev-meta">
                      {new Date(ev.at).toLocaleTimeString('en-IN', TIME_FMT)}
                      {ev.by && <> · {ev.by}</>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 2. Deals & installments
// ---------------------------------------------------------------------------

function Deals({ deals }) {
  return (
    <section className="drawer-section">
      <span className="field-label">Deals &amp; installments ({deals.length})</span>
      <div className="lp-list">
        {deals.map((d) => {
          const outcome = DEAL_OUTCOME[d.outcome] || DEAL_OUTCOME.open;
          const products = (d.products || []).map((p) => p.name).filter(Boolean);
          // `installment` is the balance still OWED on a won deal. null means never
          // recorded, 0 means paid off — they are not the same thing.
          const owed = d.outcome === 'won' && d.installment != null ? Number(d.installment) : null;
          const paid = owed != null && d.amount != null ? Number(d.amount) - owed : null;
          return (
            <div key={d._id || d.zohoId} className="lp-item">
              <div className="lp-item-head">
                <b>{d.name || 'Deal'}</b>
                <span className={`badge ${outcome.cls}`}>{outcome.label}</span>
              </div>
              <div className="fields lp-deal-grid">
                <Field label="Stage">{value(d.stage)}</Field>
                <Field label="Amount">{value(rupees(d.amount))}</Field>
                <Field label="Closing date">{value(d.closingDate)}</Field>
                <Field label="Owner">{value(d.ownerName || d.ownerEmail)}</Field>
                {products.length > 0 && <Field label="Products">{products.join(', ')}</Field>}
                {d.upScale && (
                  <Field label="Upsell">
                    <span title={d.upScale}>↑ {upsoldTo(d.upScale)}</span>
                  </Field>
                )}
                {d.outcome === 'lost' && d.lostReason && (
                  <Field label="Lost because">{d.lostReason}</Field>
                )}
                {owed != null && (
                  <Field label="Installment">
                    {owed > 0 ? (
                      <>
                        <span className="lp-owed">{rupees(owed)} pending</span>
                        {paid != null && (
                          <span className="acq-basis">{rupees(paid)} paid so far</span>
                        )}
                      </>
                    ) : (
                      <span className="lp-paid">Paid in full</span>
                    )}
                  </Field>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 3. Calls
// ---------------------------------------------------------------------------

function scoreOf(call) {
  return call.grade && Number.isFinite(call.grade.score) ? call.grade.score : null;
}

/** Mean of the graded calls, rounded; null when none are graded. */
function averageScore(calls) {
  const scores = calls.map(scoreOf).filter((n) => n != null);
  return scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
}

// The grader's provider answers "No credits available" when the account is
// empty; that call then sits unscored until someone tops it up.
const isOutOfCredits = (call) => /no credits|insufficient_quota/i.test(call.gradeError || '');

/** Why a call has no score, in a few words. */
function unscoredReason(call) {
  // A missed or unrecorded call has nothing to score; "No recording" already says so.
  if (!call.hasRecording) return null;
  if (isOutOfCredits(call)) return 'AI credits ran out';
  if (call.gradeError) return 'Scoring failed';
  if (call.transcriptionStatus && call.transcriptionStatus !== 'done') return 'Awaiting transcript';
  return 'Not scored yet';
}

function scoreClass(score) {
  if (score >= 75) return 'lp-score lp-score-good';
  if (score >= 50) return 'lp-score lp-score-mid';
  return 'lp-score lp-score-low';
}

function Calls({ calls, onOpen }) {
  const noCredits = calls.filter(isOutOfCredits).length;
  const avg = averageScore(calls);
  return (
    <section className="drawer-section">
      <span className="field-label">Calls ({calls.length})</span>
      <div className="lp-calls-summary">
        <span>
          Average call score{' '}
          {avg == null ? <b>—</b> : <span className={scoreClass(avg)}>{avg}</span>}
        </span>
        <span className="subtle">
          {calls.filter((c) => scoreOf(c) != null).length} of{' '}
          {calls.filter((c) => c.hasRecording).length} recorded calls scored
        </span>
      </div>
      {noCredits > 0 && (
        <div className="lp-warn">
          Call scoring is paused: the AI grading account has no credits left, so {noCredits} call
          {noCredits === 1 ? '' : 's'} on this lead {noCredits === 1 ? 'is' : 'are'} unscored. Top up
          the grader account and they will be scored on the next run.
        </div>
      )}
      <ul className="lp-calls">
        {calls.map((c) => (
          <CallRow key={c._id} call={c} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

// One line per call: when, which way, how long, who, verdict — then the actions.
// The AI summary and the audio player, when there are any, sit underneath.
function CallRow({ call, onOpen }) {
  // The recording is fetched only when asked for — a lead can have dozens of calls.
  const [wantAudio, setWantAudio] = useState(false);
  const { url, loading, error } = useRecordingUrl(call._id, wantAudio && call.hasRecording);
  const outcome = call.outcome ? DEAL_OUTCOME[call.outcome] : call.isClosedWon ? DEAL_OUTCOME.won : null;
  const score = scoreOf(call);
  const direction = call.direction && call.direction !== 'unknown' ? call.direction : 'call';
  const who = call.ownerEmail || call.agentExt || 'Unknown agent';
  // The mailbox part is enough to tell reps apart; the full address is on hover.
  const whoShort = String(who).split('@')[0];

  return (
    <li className="lp-call">
      <div className="lp-call-row">
        <span className="lp-call-when">{shortDateTime(call.startedAt)}</span>
        <span className={`lp-call-dir lp-call-dir-${direction}`}>
          {direction === 'inbound' ? '↙' : direction === 'outbound' ? '↗' : '•'} {direction}
        </span>
        <span className="call-dur">{ts(call.duration)}</span>
        <span className="lp-call-who" title={who}>
          {whoShort}
          {call.deal?.name ? ` · ${call.deal.name}` : ''}
        </span>
        {outcome && <span className={`badge ${outcome.cls}`}>{outcome.label}</span>}
        {score != null ? (
          <span className={scoreClass(score)} title="AI call score (0–100)">
            {score}
          </span>
        ) : (
          unscoredReason(call) && (
            <span className="lp-score-none" title={call.gradeError || undefined}>
              {unscoredReason(call)}
            </span>
          )
        )}
        <span className="lp-call-actions">
          {call.hasRecording ? (
            !wantAudio && (
              <button className="link-btn" onClick={() => setWantAudio(true)}>
                ▶ Play
              </button>
            )
          ) : (
            <span className="subtle">No recording</span>
          )}
          <button className="link-btn" onClick={() => onOpen(call._id)}>
            Transcript →
          </button>
        </span>
      </div>
      {call.grade?.summary && <p className="desc lp-call-summary">{call.grade.summary}</p>}
      {wantAudio &&
        (loading ? (
          <span className="subtle">Loading audio…</span>
        ) : url ? (
          <audio className="audio-player lp-call-audio" controls autoPlay src={url} />
        ) : (
          <span className="subtle">{error || 'Recording unavailable.'}</span>
        ))}
    </li>
  );
}

function VslEmpty({ configured }) {
  return (
    <section className="drawer-section">
      <span className="field-label">VSL watch time</span>
      <p className="subtle lp-empty-note">
        {configured
          ? 'This lead has not watched the VSL yet.'
          : 'VSL tracking is not connected on this server (VSL_MONGO_URI is not set), so watch time can’t be shown.'}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 5. Form answers
// ---------------------------------------------------------------------------

// Web lead fields worth showing, in reading order. Empty ones are skipped.
const WEB_FIELDS = [
  ['name', 'Name'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['caStatus', 'CA status'],
  ['attempt', 'Attempt'],
  ['language', 'Language'],
  ['city', 'City'],
  ['state', 'State'],
  ['source', 'Form'],
  ['utmSource', 'UTM source'],
  ['utmMedium', 'UTM medium'],
  ['utmCampaign', 'UTM campaign'],
  ['utmContent', 'UTM content'],
  ['utmTerm', 'UTM term'],
  ['landingUrl', 'Landing URL'],
  ['referrer', 'Referrer'],
];

function present(v) {
  return v != null && String(v).trim() !== '';
}

function KeyValues({ rows }) {
  return (
    <dl className="lp-kv">
      {rows.map(([k, v], i) => (
        <div key={`${k}-${i}`} className="lp-kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function webRows(lead) {
  const rows = [];
  if (!present(lead.name)) {
    const full = [lead.firstName, lead.lastName].filter(present).join(' ');
    if (full) rows.push(['Name', full]);
  }
  for (const [key, label] of WEB_FIELDS) {
    if (present(lead[key])) rows.push([label, String(lead[key])]);
  }
  return rows;
}

function metaRows(lead) {
  const rows = [];
  for (const entry of Array.isArray(lead.fieldData) ? lead.fieldData : []) {
    if (!entry || typeof entry !== 'object') continue;
    const values = (Array.isArray(entry.values) ? entry.values : [entry.values]).filter(present);
    if (!values.length) continue;
    rows.push([String(entry.name || '—').replace(/_/g, ' '), values.join(', ')]);
  }
  return rows;
}

function FormAnswers({ webLeads, metaLeads }) {
  return (
    <section className="drawer-section">
      <span className="field-label">Form answers</span>
      <div className="lp-list">
        {webLeads.map((lead) => (
          <div key={lead._id || lead.id} className="lp-item">
            <div className="lp-item-head">
              <span className="badge source-badge source-web">Web</span>
              <span className="subtle">{shortDateTime(lead.createdAt)}</span>
            </div>
            <KeyValues rows={webRows(lead)} />
          </div>
        ))}
        {metaLeads.map((lead) => {
          const rows = metaRows(lead);
          return (
            <div key={lead._id || lead.id} className="lp-item">
              <div className="lp-item-head">
                <span className="badge source-badge source-meta">Meta</span>
                <span className="subtle">{shortDateTime(lead.createdTime || lead.syncedAt)}</span>
                {lead.formId && <span className="subtle">form {lead.formId}</span>}
              </div>
              {rows.length ? <KeyValues rows={rows} /> : <p className="subtle">No answers recorded.</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 7. Older tasks
// ---------------------------------------------------------------------------

function OlderTasks({ tasks }) {
  return (
    <section className="drawer-section">
      <details className="lp-older">
        <summary className="field-label">Older follow-ups ({tasks.length})</summary>
        <ul className="timeline">
          {tasks.map((t) => {
            const b = taskBody(t);
            return (
              <li key={t.id}>
                <div>
                  <b>{b.Subject || '—'}</b>{' '}
                  <span className={statusClass(b.Status)}>{b.Status || '—'}</span>
                </div>
                <span className="subtle">
                  due {b.Due_Date || '—'} · created {shortDateTime(b.Created_Time || t.receivedAt)}
                  {b.Closed_Time ? ` · closed ${shortDateTime(b.Closed_Time)}` : ''}
                  {b.Owner?.name ? ` · ${b.Owner.name}` : ''}
                </span>
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}
