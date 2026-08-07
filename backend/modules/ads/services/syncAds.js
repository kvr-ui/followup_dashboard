// Pull every ad from Meta into MetaAd.
//
// Last of the structural syncs: an ad points at an ad set, a campaign and a
// creative, so all three must already be local for its references to resolve.
// Anything still missing is stored as null (see syncHelpers.js).
const MetaAdset = require('../models/MetaAdset');
const MetaCampaign = require('../models/MetaCampaign');
const MetaCreative = require('../models/MetaCreative');
const MetaAd = require('../models/MetaAd');
const meta = require('./metaClient');
const { keepIfKnown, loadKnownIds } = require('./syncHelpers');

/** Fetch every ad from Meta and upsert it. Returns the count. */
async function syncAds() {
  const ads = await meta.getAds();

  const [knownAdsets, knownCampaigns, knownCreatives] = await Promise.all([
    loadKnownIds(MetaAdset),
    loadKnownIds(MetaCampaign),
    loadKnownIds(MetaCreative),
  ]);

  if (ads.length) {
    await MetaAd.bulkWrite(
      ads.map((ad) => ({
        updateOne: {
          filter: { _id: ad.id },
          update: {
            $set: {
              name: ad.name,
              adsetId: keepIfKnown(ad.adsetId, knownAdsets),
              campaignId: keepIfKnown(ad.campaignId, knownCampaigns),
              status: ad.status,
              effectiveStatus: ad.effectiveStatus,
              creativeId: keepIfKnown(ad.creativeId, knownCreatives),
            },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );
  }

  return ads.length;
}

module.exports = { syncAds };
