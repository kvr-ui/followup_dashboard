import { formatDateTime, priorityClass, statusClass, getContact } from '../utils';
import { classifyDue } from '../taskStats';
import CopyButton from './CopyButton';

function TaskRow({ task, receivedAt, onSelect }) {
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
        {tasks.map(({ key, recordId, task, receivedAt }) => (
          <TaskRow
            key={key}
            task={task}
            receivedAt={receivedAt}
            onSelect={() => onSelect?.(recordId)}
          />
        ))}
      </tbody>
    </table>
  );
}
