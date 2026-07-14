/**
 * Drip sequences: fire a follow-up at whoever didn't do the thing the last step wanted.
 *
 * A step does not "send messages". A step MATERIALISES A REAL CAMPAIGN — same model,
 * same sender, same opt-out gate, same throttle, same funnel page. There is no drip
 * code path that touches WATI directly.
 *
 * That is a deliberate constraint, not an accident of design. The moment a sequence
 * gets its own private way to send, it also gets its own private way to forget the
 * suppression list — and the drip is exactly where that bug is most dangerous,
 * because a drip messages people who have ALREADY ignored you once.
 */

const Campaign = require('../models/Campaign');
const CampaignMessage = require('../models/CampaignMessage');
const Sequence = require('../models/Sequence');
const { stateFilter } = require('./funnel');
const sender = require('./sender');
const cost = require('./cost');

/**
 * Turn one step into a campaign.
 *
 * The audience is FROZEN into contactIds at fire time rather than stored as a live
 * rule. A rule would be re-evaluated when the child campaign actually sends, minutes
 * or hours later — and by then some of those "didn't read" contacts have read it, so
 * the step would chase a different, smaller crowd than the one it reported. Freezing
 * makes the child campaign's audience match what the sequence page said it would be.
 */
async function fireStep(sequence, step, parent) {
  const filter = stateFilter(parent._id, step.audience);
  const contactIds = filter
    ? await CampaignMessage.distinct('contactId', filter)
    : [];

  if (!contactIds.length) {
    step.status = 'skipped';
    step.firedAt = new Date();
    step.note = `Nobody was in "${step.audience}" — nothing to chase.`;
    return null;
  }

  const campaign = await Campaign.create({
    name: `${sequence.name} — step ${step.order}`,
    description: `Automatic follow-up to "${parent.name}", aimed at contacts in "${step.audience}".`,
    templateName: step.templateName,
    templateLanguage: step.templateLanguage,
    templateCategory: step.templateCategory,
    variables: step.variables || [],
    audience: { type: 'contacts', contactIds },
    parentCampaignId: parent._id,
    parentState: step.audience,
    sequenceId: sequence._id,
    sequenceStep: step.order,
    status: 'sending',
    startedAt: new Date(),
    ratePerMinute: parent.ratePerMinute,
    trackLinks: parent.trackLinks,
    createdBy: sequence.createdBy,
    estimatedCost: cost.estimate(step.templateCategory, contactIds.length),
  });

  await sender.materialize(campaign);

  step.status = 'fired';
  step.firedAt = new Date();
  step.campaignId = campaign._id;
  step.note = `${contactIds.length} contact(s) queued.`;

  return campaign;
}

/**
 * Fire every step that has come due.
 *
 * Delays are measured from the PARENT's completion, not from the previous step. If
 * they chained, a step 1 that took six hours to send would drag step 2 six hours late
 * and step 3 further still — and a "Day 5" message that lands on day 7 is a different
 * message. Anchoring to the parent keeps the calendar the admin designed.
 */
async function fireDue() {
  const sequences = await Sequence.find({ active: true, 'steps.status': 'pending' });
  let fired = 0;

  for (const sequence of sequences) {
    const parent = await Campaign.findById(sequence.parentCampaignId).lean();

    // Nothing fires until the parent has finished sending — a "did you read it?"
    // nudge to someone the blast hasn't reached yet is nonsense.
    if (!parent || parent.status !== 'completed' || !parent.completedAt) continue;

    let dirty = false;

    for (const step of sequence.steps) {
      if (step.status !== 'pending') continue;

      const dueAt = new Date(
        new Date(parent.completedAt).getTime() + (step.delayHours || 0) * 3600 * 1000
      );
      if (Date.now() < dueAt.getTime()) continue;

      try {
        await fireStep(sequence, step, parent);
        fired += 1;
      } catch (err) {
        step.status = 'failed';
        step.firedAt = new Date();
        step.note = err.message.slice(0, 200);
        console.warn(`[sequence] step ${step.order} of "${sequence.name}" failed:`, err.message);
      }
      dirty = true;
    }

    if (dirty) {
      if (sequence.steps.every((s) => s.status !== 'pending')) {
        sequence.active = false;
        sequence.completedAt = new Date();
      }
      await sequence.save();
    }
  }

  return fired;
}

module.exports = { fireDue, fireStep };
