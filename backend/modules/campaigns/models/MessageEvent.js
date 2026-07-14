const mongoose = require('mongoose');

/**
 * Append-only log of every status event WhatsApp reported, in arrival order.
 *
 * CampaignMessage holds the CURRENT state; this holds the HISTORY. Kept separate
 * because the current state is lossy by design (status only moves forward) and you
 * cannot reconstruct "delivered at 09:01, read at 14:32" from a single status field
 * once you start collapsing events.
 *
 * The unique index is the idempotency guard: WATI retries webhooks, sometimes for
 * hours. Without it a retried `read` event double-counts the read every time.
 */
const messageEventSchema = new mongoose.Schema(
  {
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', index: true },
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'CampaignMessage', index: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', index: true },

    phoneKey: { type: String, default: null, index: true },
    watiMessageId: { type: String, default: null },

    type: {
      type: String,
      enum: ['sent', 'delivered', 'read', 'replied', 'failed', 'clicked'],
      required: true,
    },

    occurredAt: { type: Date, default: Date.now, index: true },
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

// Idempotency: one event of each type per WATI message, so a retried webhook cannot
// double-count a read.
//
// `partialFilterExpression`, NOT `sparse`. A compound sparse index only skips a
// document when EVERY indexed field is absent — so events we generate ourselves,
// which have `watiMessageId: null`, would all still be indexed, collide on
// (null, 'clicked'), and the second click of the day would throw. The partial filter
// indexes only the rows that actually carry a provider id, which is exactly the set
// we need to deduplicate.
messageEventSchema.index(
  { watiMessageId: 1, type: 1 },
  { unique: true, partialFilterExpression: { watiMessageId: { $type: 'string' } } }
);

// "When does this audience actually read?" — the best-send-time histogram.
messageEventSchema.index({ campaignId: 1, type: 1, occurredAt: 1 });

module.exports = mongoose.model('MessageEvent', messageEventSchema);
