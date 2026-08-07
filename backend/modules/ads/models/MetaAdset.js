const mongoose = require('mongoose');
const { applyJsonTransform, syncedAtTimestamps, model } = require('./_shared');

// An ad set mirrored from Meta. `_id` is Meta's own adset id; `campaignId` is
// the MetaCampaign `_id` it belongs to.
const metaAdsetSchema = new mongoose.Schema(
  {
    _id: { type: String }, // Meta adset id
    name: { type: String, required: true },
    campaignId: String,
    status: { type: String, required: true },
    effectiveStatus: String,
    dailyBudget: Number,
    lifetimeBudget: Number,
    optimizationGoal: String,
    billingEvent: String,
    startTime: String,
    endTime: String,
  },
  syncedAtTimestamps
);

metaAdsetSchema.index({ campaignId: 1 });
applyJsonTransform(metaAdsetSchema);

module.exports = model('MetaAdset', metaAdsetSchema);
