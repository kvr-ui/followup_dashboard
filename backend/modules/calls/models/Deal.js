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

    // What was actually sold — Bigin's `Associated_Products` subform on the deal.
    // Not a field on the list endpoint, so it never arrives in the webhook and
    // isn't in a page of deals either; it costs a read of the deal record.
    //
    // In practice only WON deals carry products (the team attaches them when the
    // sale is made) — lost deals are ~4% populated, so don't read a win rate out
    // of this.
    products: {
      type: [
        {
          id: String,
          name: String,
          quantity: Number,
          listPrice: Number,
          discount: Number,
          total: Number, // line total after discount — the real revenue
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
