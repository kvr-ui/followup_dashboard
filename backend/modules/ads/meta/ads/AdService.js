const AD_FIELDS = [
  'id',
  'name',
  'adset_id',
  'campaign_id',
  'status',
  'effective_status',
  'creative{id}',
];

/**
 * @typedef {object} AdListOptions
 * @property {string} [campaignId] Restrict to a single campaign's ads.
 * @property {string} [adsetId] Restrict to a single ad set's ads.
 */

/** @returns {import('../types').Ad} */
function normalizeAd(raw) {
  return {
    id: raw.id,
    name: raw.name ?? '',
    adsetId: raw.adset_id ?? null,
    campaignId: raw.campaign_id ?? null,
    status: raw.status ?? 'UNKNOWN',
    effectiveStatus: raw.effective_status ?? null,
    creativeId: raw.creative?.id ?? null,
  };
}

class AdService {
  /**
   * @param {import('../client/MetaClient').MetaClient} client
   * @param {string} accountPath
   */
  constructor(client, accountPath) {
    this.client = client;
    this.accountPath = accountPath;
  }

  /**
   * Fetch ads for the account, or scoped to a campaign / ad set.
   * @param {AdListOptions} [options]
   */
  async list(options = {}) {
    let path = `/${this.accountPath}/ads`;
    if (options.adsetId) path = `/${options.adsetId}/ads`;
    else if (options.campaignId) path = `/${options.campaignId}/ads`;

    const raw = await this.client.getEdge(path, {
      fields: AD_FIELDS.join(','),
      limit: 200,
    });
    return raw.map(normalizeAd);
  }
}

module.exports = { AdService, normalizeAd };
