import { rupees } from '../../money';
import { upsoldTo } from '../../upsell';
import Section from '../ui/Section';
import { Field, value } from '../Field';
import { DEAL_OUTCOME } from './format';

export default function LeadDeals({ deals }) {
  return (
    <Section title="Deals & installments">
      <div className="lp-list">
        {deals.map((d) => {
          const outcome = DEAL_OUTCOME[d.outcome] || DEAL_OUTCOME.open;
          const products = (d.products || []).map((p) => p.name).filter(Boolean);
          // `installment` is the balance still OWED on a won deal. null means never
          // recorded, 0 means paid off — they are not the same thing.
          const owed = d.outcome === 'won' && d.installment != null ? Number(d.installment) : null;
          const paid = owed != null && d.amount != null ? Number(d.amount) - owed : null;
          return (
            <div key={d._id || d.zohoId} className="lp-item">
              <div className="lp-item-head">
                <b>{d.name || 'Deal'}</b>
                <span className={`badge ${outcome.cls}`}>{outcome.label}</span>
              </div>
              <div className="fields lp-deal-grid">
                <Field label="Stage">{value(d.stage)}</Field>
                <Field label="Amount">{value(rupees(d.amount))}</Field>
                <Field label="Closing date">{value(d.closingDate)}</Field>
                <Field label="Owner">{value(d.ownerName || d.ownerEmail)}</Field>
                {products.length > 0 && <Field label="Products">{products.join(', ')}</Field>}
                {d.upScale && (
                  <Field label="Upsell">
                    <span title={d.upScale}>↑ {upsoldTo(d.upScale)}</span>
                  </Field>
                )}
                {d.outcome === 'lost' && d.lostReason && (
                  <Field label="Lost because">{d.lostReason}</Field>
                )}
                {owed != null && (
                  <Field label="Installment">
                    {owed > 0 ? (
                      <>
                        <span className="lp-owed">{rupees(owed)} pending</span>
                        {paid != null && (
                          <span className="acq-basis">{rupees(paid)} paid so far</span>
                        )}
                      </>
                    ) : (
                      <span className="lp-paid">Paid in full</span>
                    )}
                  </Field>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
