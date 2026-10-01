import { leaveLead } from '../../route';
import EmptyState from '../ui/EmptyState';
import { BackButton } from './LeadHeader';

export default function LeadError({ error, onRetry }) {
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
      <div className="lp-header">
        <BackButton />
      </div>
      <EmptyState title={title}>
        <p className="lp-empty-body">{body}</p>
        <div className="lp-empty-actions">
          <button onClick={leaveLead}>← Back</button>
          {retry && <button onClick={onRetry}>Retry</button>}
        </div>
      </EmptyState>
    </div>
  );
}
