import { formatDateTime } from '../utils';
import { ENGAGEMENT, clampPct, engagementClass, formatWatch, watchBasisNote } from '../vslStats';
import { Field, dash, value } from './Field';

// ---------------------------------------------------------------------------
// VSL watch time
// ---------------------------------------------------------------------------
//
// The minutes here are the PEAK ever recorded in the VSL's event log, not the
// figure on its lead record — that one is overwritten on every beacon, so it
// falls when somebody reopens the video. On the rare row where no events exist
// the server falls back to it and stamps `basis: 'lead'`, and the note at the
// bottom of this panel says so. A number we inferred must not read like one we
// measured.

export default function VslWatch({ vsl }) {
  const watch = vsl.watch || {};
  const src = vsl.leadSource || {};
  const note = watchBasisNote(watch.basis);

  return (
    <section className="drawer-section">
      <span className="field-label">VSL watch time</span>

      <div className="fields acq-grid">
        <Field label="Minutes watched">
          <span className="vsl-minutes">{formatWatch(watch.seconds, watch.percentage)}</span>
        </Field>
        <Field label="Engagement">
          <span className={engagementClass(vsl.engagement)} title={ENGAGEMENT[vsl.engagement]?.hint}>
            {ENGAGEMENT[vsl.engagement]?.label || vsl.engagement}
          </span>
        </Field>
        <Field label="Lead source">
          {value(src.key)}
          {src.basis === 'task' && (
            <span className="acq-basis">
              From the linked ad lead, not from Bigin&apos;s lead source field.
            </span>
          )}
        </Field>
      </div>

      {/* Drawn only when the VSL actually reported a video duration — it does so
          on well under 1% of events, and an empty track beside a real watch time
          reads as "watched none of it". */}
      {watch.seconds > 0 && watch.percentage > 0 && (
        <div className="vsl-bar" title={`${Math.round(watch.percentage)}% of the video`}>
          <div
            className={watch.completed ? 'vsl-bar-fill vsl-bar-done' : 'vsl-bar-fill'}
            style={{ width: `${clampPct(watch.percentage)}%` }}
          />
        </div>
      )}

      <div className="acq-group">
        <span className="field-label acq-subhead">Timeline</span>
        <div className="fields acq-grid">
          <Field label="Link sent">{vsl.linkSentAt ? formatDateTime(vsl.linkSentAt) : dash}</Field>
          <Field label="First opened">
            {vsl.firstOpenedAt ? formatDateTime(vsl.firstOpenedAt) : dash}
          </Field>
          <Field label="First played">
            {vsl.firstPlayAt ? formatDateTime(vsl.firstPlayAt) : dash}
          </Field>
          <Field label="Last activity">
            {vsl.lastActivityAt ? formatDateTime(vsl.lastActivityAt) : dash}
          </Field>
          <Field label="Times opened">{vsl.openCount || dash}</Field>
          <Field label="Last event">{value(vsl.lastEventType)}</Field>
        </div>
      </div>

      {note && <span className="acq-basis">{note}</span>}
    </section>
  );
}
