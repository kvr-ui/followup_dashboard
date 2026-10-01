import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { formatDateTime } from '../utils';
import { ts, useRecordingUrl } from './callParts';
import DataTable from './ui/DataTable';
import Section from './ui/Section';

export default function CallDetail({ callId, onClose }) {
  const [call, setCall] = useState(null);
  const [error, setError] = useState('');
  const audioRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setCall(null);
    setError('');
    api(`/api/calls/${callId}`)
      .then((r) => { if (!cancelled) setCall(r.data); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    // Guard against a slow response for a previous callId landing after we switched.
    return () => { cancelled = true; };
  }, [callId]);

  const { url: audioUrl, loading: loadingAudio } = useRecordingUrl(
    callId,
    Boolean(call && call.hasRecording)
  );

  function seek(seconds) {
    if (audioRef.current) {
      audioRef.current.currentTime = seconds || 0;
      audioRef.current.play();
    }
  }

  const segments = call?.transcript?.segments || [];
  // The diarizer's speaker_0/speaker_1 labels are arbitrary — which one is the
  // salesperson differs per call. The grader works it out and stores it, so use
  // that when available; fall back to speaker_1 for ungraded calls.
  const agentSpeaker = call?.grade?.breakdown?.salespersonSpeaker || 'speaker_1';
  const speakerLabel = (id) => {
    if (id !== 'speaker_0' && id !== 'speaker_1') return id;
    return id === agentSpeaker ? 'Agent' : 'Customer';
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer drawer-wide" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>{call?.leadName || call?.deal?.contactName || 'Call'}</h2>
          <button className="link-danger" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="error">{error}</div>}
        {!call ? (
          <p className="subtle">Loading…</p>
        ) : (
          <>
            <section className="drawer-section fields">
              <div className="field">
                <span className="field-label">Date</span>
                <div className="field-value">{formatDateTime(call.startedAt)}</div>
              </div>
              <div className="field">
                <span className="field-label">Duration</span>
                <div className="field-value">{ts(call.duration)}</div>
              </div>
              <div className="field">
                <span className="field-label">Agent</span>
                <div className="field-value">{call.ownerEmail || call.agentExt}</div>
              </div>
              <div className="field">
                <span className="field-label">Direction</span>
                <div className="field-value">{call.direction}</div>
              </div>
              <div className="field">
                <span className="field-label">Phone</span>
                <div className="field-value">{call.leadPhone || call.to}</div>
              </div>
              <div className="field">
                <span className="field-label">Deal</span>
                <div className="field-value">
                  {call.deal?.name || '—'}{' '}
                  {call.isClosedWon && <span className="badge badge-low">Closed with Sale</span>}
                </div>
              </div>
            </section>

            {/* Audio */}
            <section className="drawer-section">
              <span className="field-label">Recording</span>
              {loadingAudio && <p className="subtle">Loading audio…</p>}
              {!loadingAudio && audioUrl && (
                <audio ref={audioRef} className="audio-player" controls src={audioUrl} />
              )}
              {!loadingAudio && !audioUrl && (
                <p className="subtle">Recording unavailable.</p>
              )}
            </section>

            {/* Grade */}
            <section className="drawer-section">
              <span className="field-label">Call grade</span>
              {call.grade?.score != null ? (
                <GradeReport grade={call.grade} />
              ) : (
                <p className="subtle">Not graded yet.</p>
              )}
            </section>

            {/* Transcript */}
            <section className="drawer-section">
              <span className="field-label">
                Transcript{' '}
                {call.transcript?.language && (
                  <span className="subtle">· {call.transcript.language}</span>
                )}
              </span>

              {call.transcriptionStatus !== 'done' && (
                <p className="subtle">
                  Status: {call.transcriptionStatus}
                  {call.transcriptionError ? ` — ${call.transcriptionError}` : ''}
                </p>
              )}

              {segments.length > 0 && (
                <div className="transcript">
                  {segments.map((s, i) => (
                    <div
                      key={i}
                      className={`turn ${s.speaker === agentSpeaker ? 'turn-agent' : 'turn-customer'}`}
                      onClick={() => seek(s.start)}
                      title="Jump to this moment"
                    >
                      <div className="turn-meta">
                        <span className="turn-who">{speakerLabel(s.speaker)}</span>
                        <span className="turn-time">{ts(s.start)}</span>
                      </div>
                      <div className="turn-text">{s.text}</div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </aside>
    </div>
  );
}

// The most a criterion can score, per rubric. Kept here only to render "8 / 25" so a
// score reads as good or bad at a glance — the grader stores the number, not the max.
// If a criterion isn't listed (rubric changed), we just show the raw number.
const CRITERION_MAX = {
  // first-call rubric
  opening: 10,
  needs_discovery: 25,
  product_pitch: 20,
  objection_handling: 25,
  next_step: 10,
  tone: 10,
  // follow-up rubric
  context_recall: 15,
  objection_progress: 30,
  new_value: 20,
  urgency: 15,
};

const prettyCriterion = (k) =>
  k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Green ≥75, amber 50–74, red below — for the overall score. */
function scoreTone(pct) {
  if (pct >= 75) return 'score-green';
  if (pct >= 50) return 'score-amber';
  return 'score-red';
}

/**
 * The full AI grade: overall score, the per-criterion breakdown with the grader's
 * reasoning, and the strengths / improvements. Everything the grader produces is
 * shown — nothing is captured and hidden, which was the previous behaviour.
 */
function GradeReport({ grade }) {
  const breakdown = grade.breakdown || {};
  const scores = breakdown.scores || {};
  const callType = breakdown.callType;

  return (
    <div className="grade-report">
      <div className="grade-box">
        <div className={`grade-score ${scoreTone(grade.score)}`}>{grade.score}</div>
        <div>
          {callType && (
            <span className="badge badge-normal grade-type">{prettyCriterion(callType)}</span>
          )}
          <p className="desc">{grade.summary}</p>
        </div>
      </div>

      {Object.keys(scores).length > 0 && (
        <DataTable>
          <thead>
            <tr>
              <th>Criterion</th>
              <th className="num">Score</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(scores).map(([k, v]) => {
              const max = CRITERION_MAX[k];
              const val = typeof v === 'object' ? v.score : v;
              const why = typeof v === 'object' ? v.why : '';
              const pct = max ? (val / max) * 100 : null;
              return (
                <tr key={k}>
                  <td>{prettyCriterion(k)}</td>
                  <td className={`num criterion-score ${pct == null ? '' : scoreTone(pct)}`.trim()}>
                    {val}
                    {max ? <span className="subtle criterion-max"> / {max}</span> : null}
                  </td>
                  <td className="subtle">{why}</td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}

      {(grade.strengths?.length > 0 || grade.improvements?.length > 0) && (
        <div className="grade-notes">
          {grade.strengths?.length > 0 && (
            <Section title="What went well" className="grade-strengths">
              <ul>
                {grade.strengths.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </Section>
          )}
          {grade.improvements?.length > 0 && (
            <Section title="To improve" className="grade-improvements">
              <ul>
                {grade.improvements.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}

      <div className="subtle grade-footnote">
        AI-graded against the FOCAS rubric. A judgment for coaching, not a verdict —
        the “why” quotes the call so you can check it.
      </div>
    </div>
  );
}
