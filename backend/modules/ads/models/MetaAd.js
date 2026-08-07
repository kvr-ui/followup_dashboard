const mongoose = require('mongoose');
const { applyJsonTransform, syncedAtTimestamps, model } = require('./_shared');

// An individual ad mirrored from Meta. `_id` is Meta's own ad id — the same id
// MetaLead.adId points at. `creativeId` is the MetaCreative `_id`.
const metaAdSchema = new mongoose.Schema(
  {
    _id: { type: String }, // Meta ad id
    name: { type: String, required: true },
    adsetId: String,
    campaignId: String,
    status: { type: String, required: true },
    effectiveStatus: String,
    creativeId: String,
  },
  syncedAtTimestamps
);

metaAdSchema.index({ adsetId: 1 });
metaAdSchema.index({ campaignId: 1 });
applyJsonTransform(metaAdSchema);

module.exports = model('MetaAd', metaAdSchema);
