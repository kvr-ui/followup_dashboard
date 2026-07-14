const mongoose = require('mongoose');

/**
 * A variable binding: how one template parameter gets its value for each contact.
 *
 *   static    -> the same string for everyone            (value: "October batch")
 *   attribute -> read off the contact                    (value: "name" -> contact.attributes.name,
 *                                                          or the top-level name/email)
 *   link      -> a URL that gets rewritten per-contact into a tracked short link
 */
const variableSchema = new mongoose.Schema(
  {
    name: { type: String, required: true }, // WATI customParam paramName
    source: { type: String, enum: ['static', 'attribute', 'link'], default: 'static' },
    value: { type: String, default: '' },
    fallback: { type: String, default: '' }, // used when an attribute is missing
  },
  { _id: false }
);

const campaignSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String, default: '' },

    // --- What we send -----------------------------------------------------------
    templateName: { type: String, required: true },
    templateLanguage: { type: String, default: '' },
    // Marketing / Utility / Authentication. Drives the cost estimate — a marketing
    // conversation costs ~7x a utility one in India, so this is not cosmetic.
    templateCategory: { type: String, default: 'MARKETING' },
    variables: { type: [variableSchema], default: [] },

    // --- Who we send to ---------------------------------------------------------
    // `segment` re-evaluates the rule at send time (an audience can grow between
    // scheduling and sending); `contacts` is a frozen list chosen by hand.
    audience: {
      type: { type: String, enum: ['segment', 'contacts', 'all'], default: 'segment' },
      segmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Segment', default: null },
      contactIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
      // Snapshot of the rule at creation time, so a later edit to the Segment doesn't
      // silently change what an already-sent campaign claims its audience was.
      rule: { type: mongoose.Schema.Types.Mixed, default: null },
    },

    // --- Lineage (this is what makes retargeting legible) ------------------------
    // Set when this campaign was spawned from another campaign's funnel state, so a
    // year from now you can still answer "where did these 300 people come from?".
    parentCampaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null, index: true },
    parentState: { type: String, default: null }, // 'read_no_click', 'delivered_not_read', ...
    sequenceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sequence', default: null, index: true },
    sequenceStep: { type: Number, default: null },

    // --- A/B ---------------------------------------------------------------------
    // Two campaigns sharing an abGroupId are two arms of one test. The audience is
    // split deterministically by contact id hash, so a contact never lands in both.
    abGroupId: { type: String, default: null, index: true },
    abVariant: { type: String, default: null }, // 'A' | 'B'
    abSplit: { type: Number, default: 50 }, // % of the audience this arm receives

    // --- Lifecycle ---------------------------------------------------------------
    status: {
      type: String,
      enum: ['draft', 'scheduled', 'sending', 'paused', 'completed', 'cancelled', 'failed'],
      default: 'draft',
      index: true,
    },
    scheduledAt: { type: Date, default: null, index: true },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    // Sends per minute. WhatsApp throttles hard and a 5,000-message blast from a
    // cold number is the fastest way to get the number's quality rating tanked.
    ratePerMinute: { type: Number, default: 20 },

    // Rewrite every http(s) URL in the rendered variables into a /r/<code> link.
    trackLinks: { type: Boolean, default: true },

    // Approval gate: a campaign over `approvalThreshold` recipients cannot leave
    // draft until an admin signs off.
    requiresApproval: { type: Boolean, default: false },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },

    // --- Counters (source of truth is CampaignMessage; these are the fast read) ---
    stats: {
      audienceSize: { type: Number, default: 0 },
      queued: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      delivered: { type: Number, default: 0 },
      read: { type: Number, default: 0 },
      replied: { type: Number, default: 0 },
      clicked: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 }, // opted out / invalid / suppressed
    },
    estimatedCost: { type: Number, default: 0 },
    actualCost: { type: Number, default: 0 },

    lastError: { type: String, default: null },
    createdBy: { type: String, default: null },
  },
  { timestamps: true }
);

campaignSchema.index({ status: 1, scheduledAt: 1 }); // the sender's work query
campaignSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Campaign', campaignSchema);
