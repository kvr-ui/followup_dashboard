import { formatDateTime, priorityClass, statusClass, getContact } from '../utils';
import { classifyDue } from '../taskStats';
import CopyButton from './CopyButton';

function TaskRow({ task, receivedAt, category, categorySource, onSelect }) {
  const who = task.Who_Id?.name || '—';
  const owner = task.Owner?.name || '—';
  const { phone } = getContact(task);
  const { bucket } = classifyDue(task);
  const rowClass = bucket === 'overdue' ? 'row-overdue' : bucket === 'today' ? 'row-today' : '';

  return (
    <tr className={`${rowClass} clickable-row`} onClick={onSelect}>
      <td>
        <div className="who">{task.Subject || '—'}</div>
      </td>
      <td>
        {category ? (
          <span
            className="badge badge-normal"
            // A category read out of the subject line is a guess. Say so, quietly —
            // don't let it pass as something the rep actually recorded in Bigin.
            style={categorySource === 'subject' ? { opacity: 0.7, fontStyle: 'italic' } : undefined}
            title={
              categorySource === 'bigin'
                ? 'Set in Bigin'
                : 'Inferred from the task subject — not set in Bigin'
            }
          >
            {category}
          </span>
        ) : (
          <span className="subtle">—</span>
        )}
      </td>
      <td>
        <div className="contact-name">{who}</div>
        {phone ? (
          <div className="phone-row">
            <a
              className="phone-link"
              href={`tel:${phone}`}
              onClick={(e) => e.stopPropagation()}
            >
              {phone}
            </a>
            <CopyButton text={phone} title="Copy phone number" />
          </div>
        ) : (
          <div className="subtle">no phone</div>
        )}
      </td>
      <td>{owner}</td>
      <td>
        <span className={statusClass(task.Status)}>{task.Status || '—'}</span>
      </td>
      <td>
        <span className={priorityClass(task.Priority)}>{task.Priority || '—'}</span>
      </td>
      <td>
        {task.Due_Date || '—'}
        {bucket === 'overdue' && <span className="tag-overdue">overdue</span>}
      </td>
      <td className="subtle">{formatDateTime(task.Created_Time)}</td>
      <td className="subtle">{formatDateTime(receivedAt)}</td>
    </tr>
  );
}

export default function TaskTable({ tasks, onSelect }) {
  return (
    <table className="tasks">
      <thead>
        <tr>
          <th>Task</th>
          <th>Category</th>
          <th>Contact</th>
          <th>Owner</th>
          <th>Status</th>
          <th>Priority</th>
          <th>Due Date</th>
          <th>Created</th>
          <th>Received</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map(({ key, recordId, task, receivedAt, category, categorySource }) => (
          <TaskRow
            key={key}
            task={task}
            receivedAt={receivedAt}
            category={category}
            categorySource={categorySource}
            onSelect={() => onSelect?.(recordId)}
          />
        ))}
      </tbody>
    </table>
  );
}
