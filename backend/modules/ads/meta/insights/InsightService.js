const { numberOr, toNumber } = require('../utils/normalize');

/** @typedef {'account'|'campaign'|'adset'|'ad'} InsightLevel */

/**
 * @typedef {object} InsightQuery
 * @property {string} from Inclusive start date, `YYYY-MM-DD`.
 * @property {string} to Inclusive end date, `YYYY-MM-DD`.
 * @property {InsightLevel} [level] Aggregation level. Defaults to `campaign`.
 * @property {string[]} [fields] Override the default set of requested metric fields.
 * @property {string[]} [breakdowns] Meta breakdowns (e.g. `["age", "gender"]`).
 */

const DEFAULT_INSIGHT_FIELDS = [
  'date_start',
  'date_stop',
  'campaign_id',
  'adset_id',
  'ad_id',
  'spend',
  'impressions',
  'reach',
  'clicks',
  'ctr',
  'cpc',
  'cpm',
  'frequency',
  'actions',
  'action_values',
  'purchase_roas',
];

function normalizeActions(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => ({
    type: entry.action_type ?? 'unknown',
    value: numberOr(entry.value, 0),
  }));
}

function normalizeRoas(entries) {
  const first = Array.isArray(entries) ? entries[0] : undefined;
  return first ? toNumber(first.value) : null;
}

/** @returns {import('../types').Insight} */
function normalizeInsight(raw) {
  return {
    dateStart: raw.date_start ?? null,
    dateStop: raw.date_stop ?? null,
    campaignId: raw.campaign_id ?? null,
    adsetId: raw.adset_id ?? null,
    adId: raw.ad_id ?? null,
    spend: numberOr(raw.spend, 0),
    impressions: numberOr(raw.impressions, 0),
    reach: numberOr(raw.reach, 0),
    clicks: numberOr(raw.clicks, 0),
    ctr: numberOr(raw.ctr, 0),
    cpc: numberOr(raw.cpc, 0),
    cpm: numberOr(raw.cpm, 0),
    frequency: numberOr(raw.frequency, 0),
    actions: normalizeActions(raw.actions),
    roas: normalizeRoas(raw.purchase_roas),
  };
}

class InsightService {
  /**
   * @param {import('../client/MetaClient').MetaClient} client
   * @param {string} accountPath
   */
  constructor(client, accountPath) {
    this.client = client;
    this.accountPath = accountPath;
  }

  /**
   * Fetch reporting metrics for the configured account over a date range.
   * @param {InsightQuery} query
   */
  async query(query) {
    const fields = (query.fields ?? DEFAULT_INSIGHT_FIELDS.slice()).join(',');
    const raw = await this.client.getEdge(`/${this.accountPath}/insights`, {
      fields,
      level: query.level ?? 'campaign',
      time_range: JSON.stringify({ since: query.from, until: query.to }),
      breakdowns: query.breakdowns?.length ? query.breakdowns.join(',') : undefined,
      limit: 500,
    });
    return raw.map(normalizeInsight);
  }
}

module.exports = { InsightService, normalizeInsight };
