const mongoose = require('mongoose');
const { applyJsonTransform, syncedAtTimestamps, model } = require('./_shared');

// A lead submitted through a Meta instant form. `_id` is Meta's own lead id.
//
// The submitted answers arrive as an untyped list of {name, values} entries, so
// `fieldData` is Mixed — the phone lives inside it under a form-specific field
// name. `phoneKey` is the extracted, normalised last-10-digit form of that
// phone, which is how a Meta lead is matched to a Task. It is DECLARED here but
// populated later (see the resolver/backfill tasks).
const metaLeadSchema = new mongoose.Schema(
  {
    _id: { type: String }, // Meta lead id
    createdTime: String,
    adId: String,
    formId: String,
    campaignId: String,
    fieldData: mongoose.Schema.Types.Mixed, // LeadFieldEntry[]

    // Last 10 digits of the phone found in fieldData — the indexed join key.
    phoneKey: { type: String, default: null, index: true },
  },
  syncedAtTimestamps
);

metaLeadSchema.index({ formId: 1 });
metaLeadSchema.index({ campaignId: 1 });
applyJsonTransform(metaLeadSchema);

module.exports = model('MetaLead', metaLeadSchema);
