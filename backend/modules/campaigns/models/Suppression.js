const mongoose = require('mongoose');

/**
 * The global do-not-message list, keyed by phone number rather than by contact.
 *
 * Contact.optedOut is the flag we read in the UI; THIS is the one that actually
 * protects us. The difference matters: a contact document can be deleted, or a
 * fresh CSV import can create a *new* contact row for the same number, and either
 * would quietly resurrect someone who said STOP. A suppression keyed on the phone
 * number survives both, because the number is the thing WhatsApp actually bills
 * and the thing the person actually owns.
 *
 * Nothing in the API deletes from this collection. Un-suppressing is a deliberate,
 * separate admin action.
 */
const suppressionSchema = new mongoose.Schema(
  {
    phoneKey: { type: String, required: true, unique: true, index: true },
    reason: {
      type: String,
      enum: ['replied_stop', 'manual', 'blocked', 'invalid_number', 'bounced'],
      default: 'manual',
    },
    // The inbound message that triggered it, when it was an opt-out reply.
    evidence: { type: String, default: null },
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null },
    createdBy: { type: String, default: null }, // null = automatic
  },
  { timestamps: true }
);

module.exports = mongoose.model('Suppression', suppressionSchema);
