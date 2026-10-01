import { statusClass } from '../../utils';
import { leaveLead } from '../../route';
import { LEAD_STATUS } from '../../adStats';
import CopyButton from '../CopyButton';
import Icon from '../ui/Icon';
import { SOURCE_LABELS } from './format';

export function BackButton() {
  return (
    <button type="button" className="lp-back" onClick={leaveLead}>
      <Icon name="back" size={14} />
      Back
    </button>
  );
}

/** The record bar: back, who the lead is, their status, and how to reach them. */
export default function LeadHeader({ header, phoneKey }) {
  const phone = header.phone || phoneKey;
  const state = LEAD_STATUS[header.state] ? header.state : 'none';
  const source = header.leadSource;
  const sourceLabel = SOURCE_LABELS[source];

  return (
    <div className="lp-header">
      <BackButton />
      <div className="lp-header-main">
        <div className="lp-title-row">
          <h1 className="lp-name">{header.name || 'Unnamed lead'}</h1>
          <span className={statusClass(state)} title={LEAD_STATUS[state].hint}>
            {LEAD_STATUS[state].label}
          </span>
          {source &&
            (sourceLabel ? (
              <span className={`badge source-badge source-${source}`}>{sourceLabel}</span>
            ) : (
              <span className="badge badge-normal" title="Lead source">
                {source}
              </span>
            ))}
        </div>
        <div className="lp-header-meta">
          <span className="phone-row">
            <a href={`tel:${phone}`}>{phone}</a>
            <CopyButton text={String(phone)} title="Copy phone number" />
          </span>
          {(header.ownerName || header.ownerEmail) && (
            <span className="lp-owner" title={header.ownerEmail || undefined}>
              <span className="subtle">Owner</span> {header.ownerName || header.ownerEmail}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
