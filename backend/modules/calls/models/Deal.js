const mongoose = require('mongoose');

// Every Bigin deal we know about — won, lost, or still open.
// Calls are tagged with the outcome so we can compare winning vs losing calls.
const dealSchema = new mongoose.Schema(
  {
    zohoId: { type: String, required: true, unique: true, index: true },

    name: String,
    stage: { type: String, index: true },
    // Normalised outcome derived from the stage.
    outcome: {
      type: String,
      enum: ['won', 'lost', 'open'],
      default: 'open',
      index: true,
    },

    closingDate: String,
    amount: { type: Number, default: 0 },

    // WHY the deal was lost — Bigin's custom `Reasons` picklist
    // (Consistent NR, Wrong Course/Level, Cold, Financial Aid, …).
    // Only meaningful for lost deals, and only ~55% of them have it filled in.
    // Like products, it is not in the webhook payload, so we fetch it by deal id.
    lostReason: { type: String, default: null, index: true },

    ownerName: String,
    ownerEmail: { type: String, index: true },

    contactId: { type: String, index: true },
    contactName: String,
    contactPhone: { type: String, index: true },

    // What was actually sold. Bigin exposes this as the deal's `Products`
    // related list — NOT a field, so it can't come through the webhook.
    // We fetch it from the API using the deal id instead.
    products: {
      type: [
        {
          id: String,
          name: String,
          category: String,
          unitPrice: Number,
          _id: false,
        },
      ],
      default: [],
    },

    modifiedTime: Date,
    // How we learned about it: the Bigin webhook, or our reconcile poll.
    source: { type: String, enum: ['webhook', 'poll', 'backfill'], default: 'poll' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Deal', dealSchema);
