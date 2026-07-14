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
    // (Consistent NR, Wrong Course/Level, Cold, Financial Aid, Class Timing Issue,
    // Not Joining, ICAI not Registered, …). Deliberately a free string, not an enum:
    // the picklist grows in Bigin (8 -> 14 options in July 2026) and an enum would
    // silently reject every new value.
    // Only meaningful for lost deals. Not in the webhook payload — fetched by deal id.
    lostReason: { type: String, default: null, index: true },

    // Bigin's custom `Up_Scale` picklist — which course the lead was upsold to
    // ("Inter G1 - Closed with Sale - (Upsell - Inter G2)"). Tracks whether a sale
    // grew beyond what the lead first asked for. Also absent from the webhook.
    upScale: { type: String, default: null, index: true },

    ownerName: String,
    ownerEmail: { type: String, index: true },

    contactId: { type: String, index: true },
    contactName: String,
    contactPhone: { type: String, index: true },
    // Strict last-10-digit key of contactPhone — the indexed join key that matches
    // this deal to its calls (Call.phoneKeys) by equality, not a regex suffix scan.
    contactPhoneKey: { type: String, default: null, index: true },

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

// afterCallStored looks up "the most recently closed deal for this contact":
// match by phone key + outcome, newest first. This compound index serves that
// query (equality on the first two fields, sort on the third) in one seek.
dealSchema.index({ contactPhoneKey: 1, outcome: 1, modifiedTime: -1 });

module.exports = mongoose.model('Deal', dealSchema);
