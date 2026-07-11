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
  useEffect(() => {
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
  }, [callId]);

  function seek(seconds) {
    if (audioRef.current) {
      audioRef.current.currentTime = seconds || 0;
      audioRef.current.play();
    }
  }

  const segments = call?.transcript?.segments || [];
  // speaker_0 / speaker_1 -> friendly labels
  const speakerLabel = (id) => (id === 'speaker_1' ? 'Agent' : id === 'speaker_0' ? 'Customer' : id);

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
                <div className="grade-box">
                  <div className="grade-score">{call.grade.score}</div>
                  <div>
                    <p className="desc">{call.grade.summary}</p>
                  </div>
                </div>
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
                      className={`turn ${s.speaker === 'speaker_1' ? 'turn-agent' : 'turn-customer'}`}
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
