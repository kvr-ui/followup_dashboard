// The one and only bridge to @santhosh785/meta-ads.
//
// That package is ESM-only — its package.json declares "type": "module" and its
// single export map entry is `import`, with no CommonJS entry point. This backend
// is CommonJS, so `require('@santhosh785/meta-ads')` throws ERR_REQUIRE_ESM. The
// way through is a dynamic `import()`, which works from CommonJS but is async and
// returns a promise.
//
// Rather than sprinkle `await import(...)` through every sync file, it happens
// here, once, and the resolved module is cached. Everything else in the ads module
// calls the plain async functions below and never sees the ESM seam. Do not add a
// dynamic import anywhere else — the whole point is that there is one place that
// knows how this package is loaded, how the client is built, and whether it is
// configured at all.
//
// This file also owns constructing the connector from the environment. The package
// deliberately never reads env itself; that is the application's job.

const PACKAGE_NAME = '@santhosh785/meta-ads';

// Resolved module, kept for synchronous instanceof checks after the first load.
let loadedModule = null;
let modulePromise = null;
let clientPromise = null;

/** Load (once) and cache the ESM module. */
function loadModule() {
  if (!modulePromise) {
    modulePromise = import(PACKAGE_NAME)
      .then((mod) => {
        loadedModule = mod;
        return mod;
      })
      .catch((err) => {
        // Don't cache a failure — a transient resolution error shouldn't poison
        // the process for its whole lifetime.
        modulePromise = null;
        throw err;
      });
  }
  return modulePromise;
}

/** Are the credentials present? Checked before any sync is attempted. */
function isConfigured() {
  return Boolean(process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID);
}

/** Build (once) and cache the connector. */
function getClient() {
  if (!clientPromise) {
    clientPromise = loadModule()
      .then((mod) => {
        if (!isConfigured()) {
          throw new Error('Meta is not configured (set META_ACCESS_TOKEN and META_AD_ACCOUNT_ID)');
        }
        return new mod.MetaAdsConnector({
          accessToken: process.env.META_ACCESS_TOKEN,
          adAccountId: process.env.META_AD_ACCOUNT_ID,
          // Undefined lets the package pick its own default version.
          apiVersion: process.env.META_API_VERSION || undefined,
        });
      })
      .catch((err) => {
        clientPromise = null;
        throw err;
      });
  }
  return clientPromise;
}

/**
 * Is this a Meta rate-limit error (i.e. worth retrying)?
 *
 * Prefers a real instanceof against the loaded module; falls back to the error
 * name, which the package sets from the constructor. The fallback matters because
 * the check runs inside a catch, where re-loading the module would be silly.
 */
function isRateLimitError(err) {
  if (!err) return false;
  if (loadedModule && loadedModule.MetaRateLimitError) {
    if (err instanceof loadedModule.MetaRateLimitError) return true;
  }
  return err.name === 'MetaRateLimitError';
}

// --- Thin pass-throughs -------------------------------------------------------
// One per connector method the sync services use. They exist so no other file
// ever holds the connector object, which is what keeps the ESM seam contained.

/** Verify the access token and return the identity behind it. */
async function validateToken() {
  const client = await getClient();
  return client.validateToken();
}

async function getCampaigns() {
  const client = await getClient();
  return client.getCampaigns();
}

async function getAdsets(options) {
  const client = await getClient();
  return client.getAdsets(options);
}

async function getAds(options) {
  const client = await getClient();
  return client.getAds(options);
}

async function getCreatives() {
  const client = await getClient();
  return client.getCreatives();
}

/** @param {{from:string, to:string, level?:string}} query — dates are YYYY-MM-DD. */
async function getInsights(query) {
  const client = await getClient();
  return client.getInsights(query);
}

async function getLeads(formId) {
  const client = await getClient();
  return client.getLeads(formId);
}

async function getLeadForms(pageId) {
  const client = await getClient();
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
