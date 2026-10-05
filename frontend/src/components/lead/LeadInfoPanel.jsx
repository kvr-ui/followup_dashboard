import Section from '../ui/Section';
import TaskActions from '../TaskActions';
import Acquisition from '../Acquisition';
import VslWatch from '../VslWatch';
import { Field } from '../Field';
import { shortDateTime } from './format';

// The pinned left column: the lead's numbers, what you can DO (always against
// the newest Task), then where they came from and how much of the VSL they saw.
export default function LeadInfoPanel({ data, stats, latestTask, zohoSync, onChanged }) {
  return (
    <aside className="lp-info">
      <Section title="Summary">
        <div className="fields lp-summary">
          <Field label="Follow-ups">{stats.followUps}</Field>
          <Field label="Calls">{stats.calls}</Field>
          <Field label="Deals">{stats.deals}</Field>
          <Field label="Forms">{stats.forms}</Field>
          <Field label="Call score">{stats.avgScore == null ? '—' : stats.avgScore}</Field>
          <Field label="Last activity">{shortDateTime(stats.lastActivity)}</Field>
        </div>
      </Section>

      {latestTask && (
        <TaskActions key={latestTask.id} task={latestTask} zohoSync={zohoSync} onChanged={onChanged} />
      )}

      {/* Always shown: "never watched" and "VSL not connected" are both answers. */}
      {data.vsl ? <VslWatch vsl={data.vsl} /> : <VslEmpty configured={data.vslConfigured !== false} />}

      {data.acquisition && <Acquisition acq={data.acquisition} />}
    </aside>
  );
}

function VslEmpty({ configured }) {
  return (
    <Section title="VSL watch time">
      <p className="subtle lp-empty-note">
        {configured
          ? 'This lead has not watched the VSL yet.'
          : 'VSL tracking is not connected on this server (VSL_MONGO_URI is not set), so watch time can’t be shown.'}
      </p>
    </Section>
  );
}
