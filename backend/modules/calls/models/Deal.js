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
