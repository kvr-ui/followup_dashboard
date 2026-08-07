// Pull every ad set from Meta into MetaAdset.
//
// Runs after campaigns: an ad set whose campaign we don't hold (archived, or
// outside this account's fetch) keeps its own row but with a null campaignId,
// rather than a dangling reference the reporting joins would silently drop.
//
// Currency: dailyBudget / lifetimeBudget are in MINOR units (paise), as received.
const MetaCampaign = require('../models/MetaCampaign');
const MetaAdset = require('../models/MetaAdset');
const meta = require('./metaClient');
const { keepIfKnown, loadKnownIds } = require('./syncHelpers');

/** Fetch every ad set from Meta and upsert it. Returns the count. */
async function syncAdsets() {
  const adsets = await meta.getAdsets();

  const knownCampaigns = await loadKnownIds(MetaCampaign);

  if (adsets.length) {
    await MetaAdset.bulkWrite(
      adsets.map((a) => ({
        updateOne: {
          filter: { _id: a.id },
          update: {
            $set: {
              name: a.name,
              campaignId: keepIfKnown(a.campaignId, knownCampaigns),
              status: a.status,
              effectiveStatus: a.effectiveStatus,
              dailyBudget: a.dailyBudget, // paise
              lifetimeBudget: a.lifetimeBudget, // paise
              optimizationGoal: a.optimizationGoal,
              billingEvent: a.billingEvent,
              startTime: a.startTime,
              endTime: a.endTime,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );
  }

  return adsets.length;
}

module.exports = { syncAdsets };
