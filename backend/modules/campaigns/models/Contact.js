const mongoose = require('mongoose');

/**
 * One document per WhatsApp CONTACT, deduped by `phoneKey` (digits + country code).
 *
 * Deliberately separate from Task. A Task document is a lead who came out of Bigin;
 * a Contact is anyone we are allowed to message — imported from Bigin, uploaded as a
 * CSV, or typed in by hand. Overloading Task would have meant inventing a fake task
 * for every cold contact, and a campaign send would then be indistinguishable from a
 * sales follow-up in the task history.
 */
const contactSchema = new mongoose.Schema(
  {
    // Digits only, with country code — the same shape wati.normalizeNumber() produces.
    // This is the join key for everything: webhooks, clicks, opt-outs, dedupe.
    phoneKey: { type: String, required: true, unique: true, index: true },
    name: { type: String, default: null },
    email: { type: String, default: null, lowercase: true },

    // Free-form fields used to fill template variables ({{name}}, {{course}}, ...).
    // Mixed because every campaign wants different columns off the CSV.
    attributes: { type: mongoose.Schema.Types.Mixed, default: {} },

    tags: { type: [String], default: [], index: true },

    source: {
      type: String,
      enum: ['manual', 'csv', 'bigin', 'wati', 'inbound'],
      default: 'manual',
      index: true,
    },

    // The rep who owns this contact, matched to User.ownerEmail. Set when imported
    // from a Bigin lead so replies can be routed back to the rep who knows them.
    ownerEmail: { type: String, lowercase: true, default: null, index: true },

    // --- Compliance -------------------------------------------------------------
    // The single gate every send passes through. Never delete an opted-out contact:
    // deleting them means the next CSV import silently re-subscribes them.
    optedOut: { type: Boolean, default: false, index: true },
    optedOutAt: { type: Date, default: null },
    optOutReason: { type: String, default: null }, // 'replied_stop' | 'manual' | 'blocked'

    // --- Session window ---------------------------------------------------------
    // WhatsApp only allows free-form (non-template) messages within 24h of the
    // contact's last INBOUND message. Stamped by the webhook on every reply.
    lastInboundAt: { type: Date, default: null },
    lastOutboundAt: { type: Date, default: null },

    // --- Rolled-up engagement (denormalised; kept current by the webhook) --------
    // Here so audience queries stay a single indexed find() instead of an aggregation
    // over millions of message rows every time an admin opens the segment builder.
    stats: {
      sent: { type: Number, default: 0 },
      delivered: { type: Number, default: 0 },
      read: { type: Number, default: 0 },
      replied: { type: Number, default: 0 },
      clicked: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },
    lastCampaignAt: { type: Date, default: null, index: true },
    lastClickAt: { type: Date, default: null },

    // Set by the webhook when WhatsApp tells us the number isn't reachable.
    invalid: { type: Boolean, default: false, index: true },
    invalidReason: { type: String, default: null },

    createdBy: { type: String, default: null }, // username
  },
  { timestamps: true }
);

// The two hot audience queries: "everyone with tag X who is contactable" and
// "everyone who hasn't been messaged since <date>".
contactSchema.index({ optedOut: 1, invalid: 1, tags: 1 });
contactSchema.index({ optedOut: 1, invalid: 1, lastCampaignAt: 1 });

module.exports = mongoose.model('Contact', contactSchema);
