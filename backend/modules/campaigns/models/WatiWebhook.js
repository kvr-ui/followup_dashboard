const mongoose = require('mongoose');

/**
 * Every inbound WATI webhook, stored raw, before we try to understand it.
 *
 * WATI's webhook payloads are inconsistent between event types and their docs lag
 * the live API — field names differ per event (`id` vs `whatsappMessageId`,
 * `waId` vs `whatsappNumber`), and new event types appear unannounced. If we only
 * kept our parsed interpretation, then the day an event arrives in a shape we
 * didn't anticipate, the data is gone for good and unreproducible.
 *
 * So: write the raw body first, always, then parse. When the parse fails or the
 * event doesn't match any message we know about, the row stays with
 * `handled: false` and a reason — which is a work queue, not a silent drop.
 *
 * Capped by a TTL index: this is a debugging aid and a replay buffer, not an
 * archive. The real history lives in MessageEvent.
 */
const watiWebhookSchema = new mongoose.Schema(
  {
    eventType: { type: String, default: null, index: true },
    watiMessageId: { type: String, default: null, index: true },
    phoneKey: { type: String, default: null, index: true },

    body: { type: mongoose.Schema.Types.Mixed, required: true },

    handled: { type: Boolean, default: false, index: true },
    // Why we couldn't act on it: 'unknown_event', 'no_matching_message',
    // 'duplicate', 'no_phone'. Populated only when handled === false.
    reason: { type: String, default: null },

    receivedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

// Keep 30 days. Long enough to debug a bad week, short enough not to grow forever.
watiWebhookSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('WatiWebhook', watiWebhookSchema);
