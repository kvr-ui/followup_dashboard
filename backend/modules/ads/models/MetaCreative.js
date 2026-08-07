const mongoose = require('mongoose');
const { applyJsonTransform, syncedAtTimestamps, model } = require('./_shared');

// The creative (copy + image/video + CTA) behind an ad. `_id` is Meta's own
// creative id, referenced by MetaAd.creativeId.
//
// `urlTags` is the raw UTM tag template Meta appends to the landing URL — it is
// what makes a WebLead's utm_campaign traceable back to a MetaCampaign.
const metaCreativeSchema = new mongoose.Schema(
  {
    _id: { type: String }, // Meta creative id
    name: String,
    title: String,
    body: String,
    imageUrl: String,
    videoId: String,
    callToActionType: String,
    linkUrl: String,
    urlTags: String,
  },
  syncedAtTimestamps
);

applyJsonTransform(metaCreativeSchema);

module.exports = model('MetaCreative', metaCreativeSchema);
