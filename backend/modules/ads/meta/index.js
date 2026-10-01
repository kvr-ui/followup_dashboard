// Fetch-only connector for the Meta (Facebook) Marketing API.
//
// Ported to CommonJS from @santhosh785/meta-ads v1.0.0 (Focas_CRM/packages/meta-ads)
// so the backend no longer depends on a private GitHub Packages install. This is
// now the source of truth — change it here.
//
// It authenticates, calls the Graph API, follows pagination, retries transient
// failures, and returns normalized data. It never reads env vars or touches the
// database; services/metaClient.js builds it from the environment.

const { MetaAdsConnector } = require('./MetaAdsConnector');
const { MetaClient } = require('./client/MetaClient');
const { CampaignService, normalizeCampaign } = require('./campaigns/CampaignService');
const { AdsetService, normalizeAdset } = require('./adsets/AdsetService');
const { AdService, normalizeAd } = require('./ads/AdService');
const { CreativeService, normalizeCreative } = require('./creatives/CreativeService');
const { InsightService, normalizeInsight } = require('./insights/InsightService');
const { LeadService, normalizeLead, normalizeLeadForm } = require('./leads/LeadService');
const { TokenValidator } = require('./auth/TokenValidator');
const { retry } = require('./utils/Retry');
const { paginate } = require('./utils/Pagination');
const { toNumber, numberOr } = require('./utils/normalize');
const errors = require('./utils/Errors');

module.exports = {
  MetaAdsConnector,
  MetaClient,
  CampaignService,
  normalizeCampaign,
  AdsetService,
  normalizeAdset,
  AdService,
  normalizeAd,
  CreativeService,
  normalizeCreative,
  InsightService,
  normalizeInsight,
  LeadService,
  normalizeLead,
  normalizeLeadForm,
  TokenValidator,
  retry,
  paginate,
  toNumber,
  numberOr,
  ...errors,
};
