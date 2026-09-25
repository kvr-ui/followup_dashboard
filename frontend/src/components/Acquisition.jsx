import { formatDateTime } from '../utils';
import { rupees, monthLabel } from '../money';
import { Field, dash, value } from './Field';

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------
//
// Where this lead came from, what it answered on the form, and — for admins —
// what it cost. The whole block is absent (not nulled) when the task has no ad
// lead linked to it, and the cost object is absent for sales users, so both are
// rendered by presence: no acquisition, no section; no cost, no cost row.

/**
 * How the campaign was matched, in the resolver's own words.
 *
 * `id` and `exact` are claims Meta's data supports; `normalized` and `alias` are
 * not, and they are not the same kind of guess — one is a string comparison that
 * ignored punctuation, the other is an admin's hand-written mapping. Same visual
 * treatment as the task-category badge when it was read out of the subject line
 * (see TaskTable), because it means the same thing: this is inferred.
 */
const MATCH_NOTE = {
  id: { inferred: false, tip: 'Meta reported this campaign with the lead.' },
  exact: { inferred: false, tip: 'The utm_campaign tag matched this campaign name exactly.' },
  normalized: {
    inferred: true,
    tip:
      'Inferred — the utm_campaign tag matched this campaign name only after ignoring ' +
      'case, spacing and punctuation. Meta did not report the campaign itself.',
  },
  alias: {
    inferred: true,
    tip:
      'Inferred — an admin mapped this utm_campaign string to this campaign by hand in ' +
      'the alias table. It is an operator’s assertion, not something Meta reported.',
  },
};

function Campaign({ campaign }) {
  if (!campaign) return dash;
  const note = MATCH_NOTE[campaign.resolvedBy] || null;
  const name = campaign.name || campaign.id;
  if (!name) return dash;
  return (
    <>
      <span
        className={note && note.inferred ? 'acq-campaign acq-inferred' : 'acq-campaign'}
        title={note ? note.tip : undefined}
      >
        {name}
      </span>
      {note && note.inferred && (
        <span className="acq-inferred-tag" title={note.tip}>
          inferred
        </span>
      )}
    </>
  );
}

/** Long, so it is clipped to one line — the full value is the hover title. */
function Url({ href }) {
  if (!href) return dash;
  return (
    <a className="acq-url" href={href} title={href} target="_blank" rel="noreferrer">
      {href}
    </a>
  );
}

export default function Acquisition({ acq }) {
  const utm = acq.utm || {};
  const qual = acq.qualification || {};
  const cost = acq.cost; // absent entirely on a sales-role response
  const sourceMedium = [utm.source, utm.medium].filter(Boolean).join(' · ');

  return (
    <section className="drawer-section">
      <span className="field-label">Acquisition</span>

      <div className="fields acq-grid">
        <Field label="Source">
          {acq.source === 'meta' ? 'Meta form' : 'Web form'}
          {acq.formLabel && <span className="acq-basis">{acq.formLabel}</span>}
        </Field>
        <Field label="Campaign">
          <Campaign campaign={acq.campaign} />
        </Field>
        <Field label="Captured">{acq.capturedAt ? formatDateTime(acq.capturedAt) : dash}</Field>
      </div>

      {/* Admins only. Absent — not blanked — for everyone else. */}
      {cost && (
        <div className="acq-group">
          <span className="field-label">Estimated cost</span>
          <div className="field-value acq-cost">{value(rupees(cost.estimated))}</div>
          <span className="acq-basis">
            {rupees(cost.campaignSpend)} campaign spend ÷ {cost.leadCount} leads in{' '}
            {monthLabel(cost.month)}
          </span>
          <span className="acq-basis">
            This lead’s share of that month’s campaign spend, split evenly across the
            campaign’s leads — an apportionment, not a per-person cost Meta reported.
          </span>
        </div>
      )}

      <div className="acq-group">
        <span className="field-label acq-subhead">UTM tags</span>
        <div className="fields acq-grid">
          <Field label="Source / medium">{value(sourceMedium)}</Field>
          <Field label="Campaign">{value(utm.campaign)}</Field>
          <Field label="Content">{value(utm.content)}</Field>
          <Field label="Term">{value(utm.term)}</Field>
        </div>
      </div>

      <div className="acq-group">
        <span className="field-label acq-subhead">Landing page</span>
        <div className="acq-stack">
          <Field label="Landing URL">
            <Url href={acq.landingUrl} />
          </Field>
          <Field label="Referrer">
            <Url href={acq.referrer} />
          </Field>
        </div>
      </div>

      <div className="acq-group">
        <span className="field-label acq-subhead">Qualification answers</span>
        <div className="fields acq-grid">
          <Field label="CA status">{value(qual.caStatus)}</Field>
          <Field label="Attempt">{value(qual.attempt)}</Field>
          <Field label="Language">{value(qual.language)}</Field>
          <Field label="City">{value(qual.city)}</Field>
          <Field label="State">{value(qual.state)}</Field>
        </div>
      </div>
    </section>
  );
}
