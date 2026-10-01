import { useState } from 'react';
import Section from '../ui/Section';
import { ts, useRecordingUrl } from '../callParts';
import { DEAL_OUTCOME, averageScore, scoreOf, shortDateTime } from './format';

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

export default function LeadCalls({ calls, onOpen }) {
  const noCredits = calls.filter(isOutOfCredits).length;
  const avg = averageScore(calls);
  return (
    <Section
      title="Calls"
      meta={`${calls.filter((c) => scoreOf(c) != null).length} of ${
        calls.filter((c) => c.hasRecording).length
      } recorded calls scored`}
      actions={
        <span className="lp-avg-score">
          Average call score{' '}
          {avg == null ? <b>—</b> : <span className={scoreClass(avg)}>{avg}</span>}
        </span>
      }
    >
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
    </Section>
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
