const mongoose = require('mongoose');
const { applyJsonTransform, syncedAtTimestamps, model } = require('./_shared');

// One row of Meta spend/performance metrics for one entity over one date range.
//
// Unlike the Meta mirror entities this uses a generated ObjectId: an insight has
// no id of its own at Meta. Its identity is the composite natural key
// (level, entityId, dateStart, dateStop), enforced by the unique index below —
// that is what makes a re-sync REPLACE a day's numbers instead of duplicating
// them. Do not drop that index.
const metaInsightSchema = new mongoose.Schema(
  {
    level: { type: String, required: true }, // account | campaign | adset | ad
    entityId: { type: String, required: true }, // id at that level ("account" for account-level)
    dateStart: { type: String, required: true },
    dateStop: { type: String, required: true },
    campaignId: String,
    adsetId: String,
    adId: String,

    spend: { type: Number, required: true },
    impressions: { type: Number, required: true },
    reach: { type: Number, required: true },
    clicks: { type: Number, required: true },
    ctr: { type: Number, required: true },
    cpc: { type: Number, required: true },
    cpm: { type: Number, required: true },
    frequency: { type: Number, required: true },
    actions: mongoose.Schema.Types.Mixed, // InsightAction[]
    roas: Number,
  },
  syncedAtTimestamps
);

// The natural key — re-syncs upsert on it.
metaInsightSchema.index({ level: 1, entityId: 1, dateStart: 1, dateStop: 1 }, { unique: true });
metaInsightSchema.index({ campaignId: 1 });
metaInsightSchema.index({ dateStart: 1, dateStop: 1 });
applyJsonTransform(metaInsightSchema);

module.exports = model('MetaInsight', metaInsightSchema);
