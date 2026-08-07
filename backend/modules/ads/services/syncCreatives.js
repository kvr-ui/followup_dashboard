// Pull every ad creative from Meta into MetaCreative.
//
// `urlTags` is the load-bearing field: it is the UTM template Meta appends to the
// landing URL, which is what lets a WebLead's utm_campaign be traced back to a
// campaign. Creatives sync before ads so MetaAd.creativeId always resolves.
const MetaCreative = require('../models/MetaCreative');
const meta = require('./metaClient');

/** Fetch every ad creative from Meta and upsert it. Returns the count. */
async function syncCreatives() {
  const creatives = await meta.getCreatives();

  if (creatives.length) {
    await MetaCreative.bulkWrite(
      creatives.map((c) => ({
        updateOne: {
          filter: { _id: c.id },
          update: {
            $set: {
              name: c.name,
              title: c.title,
              body: c.body,
              imageUrl: c.imageUrl,
              videoId: c.videoId,
              callToActionType: c.callToActionType,
              linkUrl: c.linkUrl,
              urlTags: c.urlTags,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );
  }

  return creatives.length;
}

module.exports = { syncCreatives };
