import Section from '../ui/Section';
import { shortDateTime } from './format';

// Web lead fields worth showing, in reading order. Empty ones are skipped.
const WEB_FIELDS = [
  ['name', 'Name'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['caStatus', 'CA status'],
  ['attempt', 'Attempt'],
  ['language', 'Language'],
  ['city', 'City'],
  ['state', 'State'],
  ['source', 'Form'],
  ['utmSource', 'UTM source'],
  ['utmMedium', 'UTM medium'],
  ['utmCampaign', 'UTM campaign'],
  ['utmContent', 'UTM content'],
  ['utmTerm', 'UTM term'],
  ['landingUrl', 'Landing URL'],
  ['referrer', 'Referrer'],
];

function present(v) {
  return v != null && String(v).trim() !== '';
}

function KeyValues({ rows }) {
  return (
    <dl className="lp-kv">
      {rows.map(([k, v], i) => (
        <div key={`${k}-${i}`} className="lp-kv-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function webRows(lead) {
  const rows = [];
  if (!present(lead.name)) {
    const full = [lead.firstName, lead.lastName].filter(present).join(' ');
    if (full) rows.push(['Name', full]);
  }
  for (const [key, label] of WEB_FIELDS) {
    if (present(lead[key])) rows.push([label, String(lead[key])]);
  }
  return rows;
}

function metaRows(lead) {
  const rows = [];
  for (const entry of Array.isArray(lead.fieldData) ? lead.fieldData : []) {
    if (!entry || typeof entry !== 'object') continue;
    const values = (Array.isArray(entry.values) ? entry.values : [entry.values]).filter(present);
    if (!values.length) continue;
    rows.push([String(entry.name || '—').replace(/_/g, ' '), values.join(', ')]);
  }
  return rows;
}

export default function LeadForms({ webLeads, metaLeads }) {
  return (
    <Section title="Form answers">
      <div className="lp-list">
        {webLeads.map((lead) => (
          <div key={lead._id || lead.id} className="lp-item">
            <div className="lp-item-head">
              <span className="badge source-badge source-web">Web</span>
              <span className="subtle">{shortDateTime(lead.createdAt)}</span>
            </div>
            <KeyValues rows={webRows(lead)} />
          </div>
        ))}
        {metaLeads.map((lead) => {
          const rows = metaRows(lead);
          return (
            <div key={lead._id || lead.id} className="lp-item">
              <div className="lp-item-head">
                <span className="badge source-badge source-meta">Meta</span>
                <span className="subtle">{shortDateTime(lead.createdTime || lead.syncedAt)}</span>
                {lead.formId && <span className="subtle">form {lead.formId}</span>}
              </div>
              {rows.length ? <KeyValues rows={rows} /> : <p className="subtle">No answers recorded.</p>}
            </div>
          );
        })}
      </div>
    </Section>
  );
}
