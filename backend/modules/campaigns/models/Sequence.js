const mongoose = require('mongoose');

/**
 * A drip: a parent campaign plus timed follow-up steps, each aimed at whoever did
 * NOT do the thing the previous step wanted.
 *
 *   Day 0  blast                      -> the parent campaign
 *   Day 2  step 1, audience: delivered_not_read   -> "did you see this?"
 *   Day 5  step 2, audience: read_no_click        -> different hook, same offer
 *
 * Each step, when it fires, materialises a real child Campaign (parentCampaignId +
 * sequenceId set). Nothing about a step is special at send time — it goes through
 * exactly the same sender, opt-out gate and throttle as a hand-made campaign. That
 * is deliberate: a drip that could bypass the opt-out check would be a liability.
 */
const stepSchema = new mongoose.Schema(
  {
    order: { type: Number, required: true },

    // Hours after the PARENT campaign completed (not after the previous step), so a
    // slow-sending step 1 can't push the whole ladder off its intended schedule.
    delayHours: { type: Number, default: 48 },

    templateName: { type: String, required: true },
    templateLanguage: { type: String, default: '' },
    templateCategory: { type: String, default: 'MARKETING' },
    variables: { type: mongoose.Schema.Types.Mixed, default: [] },

    // Which of the parent's funnel states this step chases.
    audience: {
      type: String,
      enum: [
        'delivered_not_read',
        'read_no_click',
        'clicked_no_reply',
        'no_reply',
        'not_delivered',
        'all',
      ],
      default: 'delivered_not_read',
    },

    status: {
      type: String,
      enum: ['pending', 'fired', 'skipped', 'failed'],
      default: 'pending',
    },
    firedAt: { type: Date, default: null },
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null },
    note: { type: String, default: null }, // e.g. "skipped: audience was empty"
  },
  { _id: true }
);

const sequenceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    parentCampaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campaign',
      required: true,
      index: true,
    },
    steps: { type: [stepSchema], default: [] },

    active: { type: Boolean, default: true, index: true },
    completedAt: { type: Date, default: null },
    createdBy: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Sequence', sequenceSchema);
