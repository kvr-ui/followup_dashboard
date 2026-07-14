const mongoose = require('mongoose');

/**
 * One row per (campaign, contact). The spine of the whole module: every funnel
 * number, every retarget audience, and every cost figure is a query over this.
 *
 * On statuses — WhatsApp events do NOT arrive in order. A `delivered` webhook can
 * land after a `read` webhook (different queues, retries). So status is a RANK, not
 * a timeline, and it only ever moves forward. The timestamps below keep the real
 * per-event times regardless of arrival order.
 */
const STATUS_RANK = {
  queued: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  replied: 5,
  // Terminal, off the ladder — a failure never becomes a delivery.
  failed: -1,
  skipped: -2,
};

const linkSchema = new mongoose.Schema(
  {
    code: { type: String, required: true }, // the /r/<code> token, unique per message
    targetUrl: { type: String, required: true },
    clicks: { type: Number, default: 0 },
    firstClickAt: { type: Date, default: null },
    lastClickAt: { type: Date, default: null },
  },
  { _id: false }
);

const campaignMessageSchema = new mongoose.Schema(
  {
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true, index: true },
    phoneKey: { type: String, required: true, index: true },

    status: {
      type: String,
      enum: Object.keys(STATUS_RANK),
      default: 'queued',
      index: true,
    },

    // WATI's id for the sent message. The join key for every inbound webhook.
    watiMessageId: { type: String, default: null, index: true, sparse: true },
    watiTicketId: { type: String, default: null },
    conversationId: { type: String, default: null },

    queuedAt: { type: Date, default: Date.now },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    repliedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },

    // What the contact actually saw. Stored rendered, per contact, because six weeks
    // from now "why did this one convert" is unanswerable if we only kept the template
    // name and the variables have since been edited.
    renderedVariables: { type: mongoose.Schema.Types.Mixed, default: {} },
    templateName: { type: String, default: null },

    links: { type: [linkSchema], default: [] },
    clickCount: { type: Number, default: 0, index: true },
    firstClickAt: { type: Date, default: null },

    replyText: { type: String, default: null }, // first inbound reply, for the inbox
    errorCode: { type: String, default: null },
    errorMessage: { type: String, default: null },
    skipReason: { type: String, default: null }, // 'opted_out' | 'invalid' | 'suppressed' | 'duplicate'

    attempts: { type: Number, default: 0 },
    cost: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// A contact must never receive the same campaign twice — this is the guard that
// makes the sender safe to retry, restart, and run in more than one process.
campaignMessageSchema.index({ campaignId: 1, contactId: 1 }, { unique: true });

// The sender's work query, and the funnel/segment queries.
campaignMessageSchema.index({ campaignId: 1, status: 1 });
campaignMessageSchema.index({ 'links.code': 1 });

campaignMessageSchema.statics.STATUS_RANK = STATUS_RANK;

/** True when `next` is a forward move from `current`. Used by the webhook. */
campaignMessageSchema.statics.advances = function advances(current, next) {
  const from = STATUS_RANK[current];
  const to = STATUS_RANK[next];
  if (to === undefined || from === undefined) return false;
  if (from < 0) return false; // failed/skipped are terminal
  return to > from;
};

module.exports = mongoose.model('CampaignMessage', campaignMessageSchema);
