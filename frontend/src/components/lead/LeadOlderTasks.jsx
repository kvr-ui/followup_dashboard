import { statusClass } from '../../utils';
import Section from '../ui/Section';
import { taskBody } from '../TaskActions';
import { shortDateTime } from './format';

// Older Tasks are read-only; their notes already sit in the timeline.
export default function LeadOlderTasks({ tasks }) {
  return (
    <Section title="Older follow-ups">
      <ul className="lp-older">
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
    </Section>
  );
}
