const { toNumber } = require('../utils/normalize');

const CAMPAIGN_FIELDS = [
  'id',
  'name',
  'objective',
  'status',
  'effective_status',
  'daily_budget',
  'lifetime_budget',
  'created_time',
  'updated_time',
];

/** @returns {import('../types').Campaign} */
function normalizeCampaign(raw) {
  return {
    id: raw.id,
    name: raw.name ?? '',
    objective: raw.objective ?? null,
    status: raw.status ?? 'UNKNOWN',
    effectiveStatus: raw.effective_status ?? null,
    dailyBudget: toNumber(raw.daily_budget),
    lifetimeBudget: toNumber(raw.lifetime_budget),
    createdTime: raw.created_time ?? null,
    updatedTime: raw.updated_time ?? null,
  };
}

class CampaignService {
  /**
   * @param {import('../client/MetaClient').MetaClient} client
   * @param {string} accountPath
   */
  constructor(client, accountPath) {
    this.client = client;
    this.accountPath = accountPath;
  }

  /** Fetch all campaigns for the configured ad account. */
  async list() {
    const raw = await this.client.getEdge(`/${this.accountPath}/campaigns`, {
      fields: CAMPAIGN_FIELDS.join(','),
      limit: 200,
    });
    return raw.map(normalizeCampaign);
  }
}

module.exports = { CampaignService, normalizeCampaign };
