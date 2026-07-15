import { useEffect, useRef, useState } from 'react';
import { api, getToken } from '../api';
import { formatDateTime } from '../utils';

function ts(sec) {
  const s = Math.round(sec || 0);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export default function CallDetail({ callId, onClose }) {
  const [call, setCall] = useState(null);
  const [error, setError] = useState('');
  const [audioUrl, setAudioUrl] = useState(null);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const audioRef = useRef(null);

  useEffect(() => {
    api(`/api/calls/${callId}`)
      .then((r) => setCall(r.data))
      .catch((e) => setError(e.message));
  }, [callId]);

  // The recording route needs an auth header, so <audio src> can't fetch it
  // directly — pull it as a blob and hand the player an object URL.
  // Wait for the call to load and only fetch when it actually has a recording,
  // otherwise we fire a guaranteed 404 on every call that has no audio.
  useEffect(() => {
    if (!call) return;
    if (!call.hasRecording) {
      setAudioUrl(null);
      setLoadingAudio(false);
      return;
    }
    let revoked = null;
    setLoadingAudio(true);
    fetch(`/api/calls/${callId}/recording`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('Recording unavailable'))))
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        revoked = url;
        setAudioUrl(url);
      })
      .catch(() => setAudioUrl(null))
      .finally(() => setLoadingAudio(false));
    return () => {
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [call, callId]);

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
function scoreColor(pct) {
  if (pct >= 75) return 'var(--green, #4d7a63)';
  if (pct >= 50) return 'var(--amber, #b8860b)';
  return 'var(--red, #c0392b)';
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
    <div>
      <div className="grade-box">
        <div className="grade-score" style={{ color: scoreColor(grade.score) }}>
          {grade.score}
        </div>
        <div>
          {callType && (
            <span className="badge badge-normal" style={{ marginBottom: 6 }}>
              {prettyCriterion(callType)}
            </span>
          )}
          <p className="desc">{grade.summary}</p>
        </div>
      </div>

      {Object.keys(scores).length > 0 && (
        <table className="tasks" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Criterion</th>
              <th style={{ textAlign: 'right' }}>Score</th>
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
                  <td
                    style={{
                      textAlign: 'right',
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                      color: pct == null ? 'inherit' : scoreColor(pct),
                    }}
                  >
                    {val}
                    {max ? <span className="subtle" style={{ fontWeight: 400 }}> / {max}</span> : null}
                  </td>
                  <td className="subtle">{why}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {(grade.strengths?.length > 0 || grade.improvements?.length > 0) && (
        <div className="mini-grid" style={{ marginTop: 12 }}>
          {grade.strengths?.length > 0 && (
            <div className="panel-sm">
              <h3 style={{ color: 'var(--green, #4d7a63)' }}>What went well</h3>
              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                {grade.strengths.map((s, i) => (
                  <li key={i} style={{ fontSize: '0.85rem', marginBottom: 4 }}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {grade.improvements?.length > 0 && (
            <div className="panel-sm">
              <h3 style={{ color: 'var(--amber, #b8860b)' }}>To improve</h3>
              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                {grade.improvements.map((s, i) => (
                  <li key={i} style={{ fontSize: '0.85rem', marginBottom: 4 }}>{s}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="subtle" style={{ marginTop: 10, fontSize: '0.75rem' }}>
        AI-graded against the FOCAS rubric. A judgment for coaching, not a verdict —
        the “why” quotes the call so you can check it.
      </div>
    </div>
  );
}
