// Pull every campaign from Meta into MetaCampaign.
//
// `_id` IS Meta's campaign id, so the upsert keys straight on it — one write per
// campaign, no read-then-write.
//
// Currency: dailyBudget / lifetimeBudget arrive in the account currency's MINOR
// units (paise) and are stored exactly as received. Insight `spend` is in MAJOR
// units (rupees). The two are never reconciled here — see syncInsights.js.
const MetaCampaign = require('../models/MetaCampaign');
const meta = require('./metaClient');

/** Fetch every campaign from Meta and upsert it. Returns the count. */
async function syncCampaigns() {
  const campaigns = await meta.getCampaigns();

  if (campaigns.length) {
    await MetaCampaign.bulkWrite(
      campaigns.map((c) => ({
        updateOne: {
          filter: { _id: c.id },
          update: {
            $set: {
              name: c.name,
              objective: c.objective,
              status: c.status,
              effectiveStatus: c.effectiveStatus,
              dailyBudget: c.dailyBudget, // paise
              lifetimeBudget: c.lifetimeBudget, // paise
              createdTime: c.createdTime,
              updatedTime: c.updatedTime,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );
  }

  return campaigns.length;
}

module.exports = { syncCampaigns };
