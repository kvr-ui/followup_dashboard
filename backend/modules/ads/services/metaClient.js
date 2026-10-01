// The one and only place that builds the Meta connector (../meta).
//
// The connector deliberately never reads env itself; constructing it from the
// environment is the application's job, and it happens here, once. Everything
// else in the ads module calls the plain async functions below and never holds
// the connector object — so there is one place that knows how the client is
// built and whether it is configured at all.

const { MetaAdsConnector, MetaRateLimitError } = require('../meta');

let connector = null;

/** Are the credentials present? Checked before any sync is attempted. */
function isConfigured() {
  return Boolean(process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID);
}

/** Build (once) and cache the connector. */
function getClient() {
  if (!connector) {
    if (!isConfigured()) {
      throw new Error('Meta is not configured (set META_ACCESS_TOKEN and META_AD_ACCOUNT_ID)');
    }
    connector = new MetaAdsConnector({
      accessToken: process.env.META_ACCESS_TOKEN,
      adAccountId: process.env.META_AD_ACCOUNT_ID,
      // Undefined lets the connector pick its own default version.
      apiVersion: process.env.META_API_VERSION || undefined,
    });
  }
  return connector;
}

/**
 * Is this a Meta rate-limit error (i.e. worth retrying)?
 *
 * The name check is a fallback for errors that crossed a boundary where the
 * prototype chain was lost (e.g. re-thrown as a plain object).
 */
function isRateLimitError(err) {
  if (!err) return false;
  return err instanceof MetaRateLimitError || err.name === 'MetaRateLimitError';
}

// --- Thin pass-throughs -------------------------------------------------------
// One per connector method the sync services use. They exist so no other file
// ever holds the connector object. They stay async so a "not configured" error
// surfaces as a rejected promise, as callers expect.

/** Verify the access token and return the identity behind it. */
async function validateToken() {
  const client = getClient();
  return client.validateToken();
}

async function getCampaigns() {
  const client = getClient();
  return client.getCampaigns();
}

async function getAdsets(options) {
  const client = getClient();
  return client.getAdsets(options);
}

async function getAds(options) {
  const client = getClient();
  return client.getAds(options);
}

async function getCreatives() {
  const client = getClient();
  return client.getCreatives();
}

/** @param {{from:string, to:string, level?:string}} query — dates are YYYY-MM-DD. */
async function getInsights(query) {
  const client = getClient();
  return client.getInsights(query);
}

async function getLeads(formId) {
  const client = getClient();
  return client.getLeads(formId);
}

async function getLeadForms(pageId) {
  const client = getClient();
  return client.getLeadForms(pageId);
}

module.exports = {
  isConfigured,
  isRateLimitError,
  validateToken,
  getCampaigns,
  getAdsets,
  getAds,
  getCreatives,
  getInsights,
  getLeads,
  getLeadForms,
};
