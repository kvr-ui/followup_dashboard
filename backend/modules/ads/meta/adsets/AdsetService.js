const { toNumber } = require('../utils/normalize');

const ADSET_FIELDS = [
  'id',
  'name',
  'campaign_id',
  'status',
  'effective_status',
  'daily_budget',
  'lifetime_budget',
  'optimization_goal',
  'billing_event',
  'start_time',
  'end_time',
];

/** @typedef {{campaignId?: string}} AdsetListOptions Restrict to a single campaign's ad sets. */

/** @returns {import('../types').Adset} */
function normalizeAdset(raw) {
  return {
    id: raw.id,
    name: raw.name ?? '',
    campaignId: raw.campaign_id ?? null,
    status: raw.status ?? 'UNKNOWN',
    effectiveStatus: raw.effective_status ?? null,
    dailyBudget: toNumber(raw.daily_budget),
    lifetimeBudget: toNumber(raw.lifetime_budget),
    optimizationGoal: raw.optimization_goal ?? null,
    billingEvent: raw.billing_event ?? null,
    startTime: raw.start_time ?? null,
    endTime: raw.end_time ?? null,
  };
}

class AdsetService {
  /**
   * @param {import('../client/MetaClient').MetaClient} client
   * @param {string} accountPath
   */
  constructor(client, accountPath) {
    this.client = client;
    this.accountPath = accountPath;
  }

  /**
   * Fetch ad sets for the account, or for a single campaign when specified.
   * @param {AdsetListOptions} [options]
   */
  async list(options = {}) {
    const path = options.campaignId
      ? `/${options.campaignId}/adsets`
      : `/${this.accountPath}/adsets`;
    const raw = await this.client.getEdge(path, {
      fields: ADSET_FIELDS.join(','),
      limit: 200,
    });
    return raw.map(normalizeAdset);
  }
}

module.exports = { AdsetService, normalizeAdset };
