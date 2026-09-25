import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { formatDateTime, statusClass } from '../utils';
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
// Main: what HAPPENED, in a fixed order, each section drawn only when it has data.
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

  return (
    <div className="lead-profile">
      <ProfileHeader header={header} phoneKey={phoneKey} />

      {/* A refetch after an action failed: keep the page, say so. */}
      {error && (
        <div className="error">
          {error.message}{' '}
          <button className="link-btn" onClick={refetch}>
            Retry
          </button>
        </div>
      )}

      <div className={latestTask ? 'lp-grid' : 'lp-grid lp-single'}>
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
          {timeline.length > 0 && <Timeline events={timeline} />}
          {deals.length > 0 && <Deals deals={deals} />}
          {calls.length > 0 && <Calls calls={calls} onOpen={setOpenCallId} />}
          {data.vsl && <VslWatch vsl={data.vsl} />}
          {hasForms && <FormAnswers webLeads={webLeads} metaLeads={metaLeads} />}
          {data.acquisition && <Acquisition acq={data.acquisition} />}
          {olderTasks.length > 0 && <OlderTasks tasks={olderTasks} />}
        </div>
      </div>

      {openCallId && <CallDetail callId={openCallId} onClose={() => setOpenCallId(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header, back, error states
// ---------------------------------------------------------------------------

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

function ProfileHeader({ header, phoneKey }) {
  const phone = header.phone || phoneKey;
  const state = LEAD_STATUS[header.state] ? header.state : 'none';
  const source = header.leadSource;
  const sourceLabel = SOURCE_LABELS[source];

  return (
    <div className="lp-header">
      <BackLink />
      <div className="lp-header-main">
        <h2 className="lp-name">{header.name || 'Unnamed lead'}</h2>
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
            <span className="subtle" title={header.ownerEmail || undefined}>
              Owner: {header.ownerName || header.ownerEmail}
            </span>
          )}
        </div>
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

function Timeline({ events }) {
  return (
    <section className="drawer-section">
      <span className="field-label">Timeline</span>
      <ul className="timeline lp-timeline">
        {events.map((ev, i) => (
          <li key={`${ev.at}-${i}`} className={`lp-ev lp-ev-${ev.type}`}>
            <div className="lp-ev-head">
              <span className={`badge lp-type lp-type-${ev.type}`}>
                {TIMELINE_LABELS[ev.type] || ev.type}
              </span>
              <span className="subtle">{formatDateTime(ev.at)}</span>
            </div>
            <div className="lp-ev-text">{ev.text}</div>
            {ev.by && <span className="subtle lp-ev-by">by {ev.by}</span>}
          </li>
        ))}
      </ul>
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
              <div className="fields acq-grid">
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

function Calls({ calls, onOpen }) {
  return (
    <section className="drawer-section">
      <span className="field-label">Calls ({calls.length})</span>
      <div className="lp-list">
        {calls.map((c) => (
          <CallRow key={c._id} call={c} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

function CallRow({ call, onOpen }) {
  // The recording is fetched only when asked for — a lead can have dozens of calls.
  const [wantAudio, setWantAudio] = useState(false);
  const { url, loading, error } = useRecordingUrl(call._id, wantAudio && call.hasRecording);
  const outcome = call.outcome ? DEAL_OUTCOME[call.outcome] : call.isClosedWon ? DEAL_OUTCOME.won : null;
  const score = call.grade && Number.isFinite(call.grade.score) ? call.grade.score : null;

  return (
    <div className="lp-item">
      <div className="lp-item-head">
        <b>{formatDateTime(call.startedAt)}</b>
        <span className="subtle">{call.direction && call.direction !== 'unknown' ? call.direction : 'call'}</span>
        <span className="call-dur">{ts(call.duration)}</span>
        {outcome && <span className={`badge ${outcome.cls}`}>{outcome.label}</span>}
        {score != null && <span className="score-pill">{score}</span>}
      </div>
      <div className="subtle lp-call-meta">
        {call.ownerEmail || call.agentExt || 'Unknown agent'}
        {call.deal?.name ? ` · ${call.deal.name}` : ''}
      </div>
      {call.grade?.summary && <p className="desc lp-call-summary">{call.grade.summary}</p>}

      <div className="lp-call-actions">
        {call.hasRecording ? (
          !wantAudio ? (
            <button className="link-btn" onClick={() => setWantAudio(true)}>
              ▶ Play recording
            </button>
          ) : loading ? (
            <span className="subtle">Loading audio…</span>
          ) : url ? (
            <audio className="audio-player" controls autoPlay src={url} />
          ) : (
            <span className="subtle">{error || 'Recording unavailable.'}</span>
          )
        ) : (
          <span className="subtle">No recording</span>
        )}
        <button className="link-btn" onClick={() => onOpen(call._id)}>
          Transcript &amp; grade →
        </button>
      </div>
    </div>
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
              <span className="subtle">{formatDateTime(lead.createdAt)}</span>
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
                <span className="subtle">{formatDateTime(lead.createdTime || lead.syncedAt)}</span>
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
                  due {b.Due_Date || '—'} · created {formatDateTime(b.Created_Time || t.receivedAt)}
                  {b.Closed_Time ? ` · closed ${formatDateTime(b.Closed_Time)}` : ''}
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
