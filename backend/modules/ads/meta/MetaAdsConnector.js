const { MetaClient } = require('./client/MetaClient');
const { TokenValidator } = require('./auth/TokenValidator');
const { CampaignService } = require('./campaigns/CampaignService');
const { AdsetService } = require('./adsets/AdsetService');
const { AdService } = require('./ads/AdService');
const { CreativeService } = require('./creatives/CreativeService');
const { InsightService } = require('./insights/InsightService');
const { LeadService } = require('./leads/LeadService');

function normalizeAccountPath(adAccountId) {
  const trimmed = adAccountId.trim();
  return trimmed.startsWith('act_') ? trimmed : `act_${trimmed}`;
}

/**
 * The connector's entry point. Composes the low-level client and per-resource
 * services into a single fetch-only facade.
 *
 * It does not touch a database, environment variables, or any CRM concept —
 * the caller supplies all configuration and decides what to do with the data.
 */
class MetaAdsConnector {
  /** @param {import('./types').MetaAdsConfig} config */
  constructor(config) {
    if (!config.accessToken) {
      throw new Error('MetaAdsConnector requires an accessToken');
    }
    if (!config.adAccountId) {
      throw new Error('MetaAdsConnector requires an adAccountId');
    }

    /** The underlying HTTP client, exposed for advanced/raw calls. */
    this.client = new MetaClient({
      accessToken: config.accessToken,
      apiVersion: config.apiVersion,
      baseUrl: config.baseUrl,
      maxRetries: config.maxRetries,
      timeoutMs: config.timeoutMs,
    });
    this.accountPath = normalizeAccountPath(config.adAccountId);

    this.tokenValidator = new TokenValidator(this.client);
    this.campaigns = new CampaignService(this.client, this.accountPath);
    this.adsets = new AdsetService(this.client, this.accountPath);
    this.ads = new AdService(this.client, this.accountPath);
    this.creatives = new CreativeService(this.client, this.accountPath);
    this.insights = new InsightService(this.client, this.accountPath);
    this.leads = new LeadService(this.client);
  }

  /** Verify the access token and return the associated identity. */
  validateToken() {
    return this.tokenValidator.validate();
  }

  getCampaigns() {
    return this.campaigns.list();
  }

  /** @param {import('./adsets/AdsetService').AdsetListOptions} [options] */
  getAdsets(options) {
    return this.adsets.list(options);
  }

  /** @param {import('./ads/AdService').AdListOptions} [options] */
  getAds(options) {
    return this.ads.list(options);
  }

  getCreatives() {
    return this.creatives.list();
  }

  /** @param {import('./insights/InsightService').InsightQuery} query */
  getInsights(query) {
    return this.insights.query(query);
  }

  /** @param {string} formId */
  getLeads(formId) {
    return this.leads.getLeads(formId);
  }

  /** @param {string} pageId */
  getLeadForms(pageId) {
    return this.leads.getForms(pageId);
  }
}

module.exports = { MetaAdsConnector };
