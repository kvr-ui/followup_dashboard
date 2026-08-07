const mongoose = require('mongoose');
const { applyJsonTransform, syncedAtTimestamps, model } = require('./_shared');

// A campaign mirrored from the Meta Marketing API.
//
// `_id` is Meta's own campaign id (a String, not an ObjectId). That is
// deliberate: upserts key straight on it, and every cross-reference below
// (MetaAdset.campaignId, MetaAd.campaignId, MetaInsight.campaignId,
// WebLead.resolvedCampaignId) stores that same Meta id.
const metaCampaignSchema = new mongoose.Schema(
  {
    _id: { type: String }, // Meta campaign id
    name: { type: String, required: true },
    objective: String,
    status: { type: String, required: true },
    effectiveStatus: String,
    dailyBudget: Number, // account currency minor units (paise/cents)
    lifetimeBudget: Number,
    createdTime: String,
    updatedTime: String,
  },
  syncedAtTimestamps
);

metaCampaignSchema.index({ status: 1 });
applyJsonTransform(metaCampaignSchema);

module.exports = model('MetaCampaign', metaCampaignSchema);
