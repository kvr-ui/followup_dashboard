// Shapes of the normalized data the connector returns. JSDoc only — nothing is
// exported at runtime; the typedefs exist for editor hints via
// `import('./types').Campaign` etc.

/**
 * Cursor / next-page metadata returned by Graph API "edge" responses.
 * @typedef {{cursors?: {before?: string, after?: string}, next?: string, previous?: string}} Paging
 */

/**
 * Standard shape of a Graph API list ("edge") response.
 * @template T
 * @typedef {{data?: T[], paging?: Paging}} GraphListResponse
 */

/**
 * Configuration accepted by MetaAdsConnector.
 * @typedef {object} MetaAdsConfig
 * @property {string} accessToken A valid Meta access token (user, page, or system-user token).
 * @property {string} adAccountId Ad account id, with or without the `act_` prefix.
 * @property {string} [apiVersion] Graph API version. Defaults to `v24.0`.
 * @property {string} [baseUrl] Base URL override (useful for testing). Defaults to `https://graph.facebook.com`.
 * @property {number} [maxRetries] Maximum number of retry attempts for transient failures. Defaults to `3`.
 * @property {number} [timeoutMs] Per-request timeout in milliseconds. Defaults to `30000`.
 */

/**
 * Normalized Meta campaign. Budgets are in the account currency's minor units (paise).
 * @typedef {object} Campaign
 * @property {string} id
 * @property {string} name
 * @property {string|null} objective
 * @property {string} status
 * @property {string|null} effectiveStatus
 * @property {number|null} dailyBudget
 * @property {number|null} lifetimeBudget
 * @property {string|null} createdTime
 * @property {string|null} updatedTime
 */

/**
 * Normalized Meta ad set.
 * @typedef {object} Adset
 * @property {string} id
 * @property {string} name
 * @property {string|null} campaignId
 * @property {string} status
 * @property {string|null} effectiveStatus
 * @property {number|null} dailyBudget
 * @property {number|null} lifetimeBudget
 * @property {string|null} optimizationGoal
 * @property {string|null} billingEvent
 * @property {string|null} startTime
 * @property {string|null} endTime
 */

/**
 * Normalized Meta ad.
 * @typedef {object} Ad
 * @property {string} id
 * @property {string} name
 * @property {string|null} adsetId
 * @property {string|null} campaignId
 * @property {string} status
 * @property {string|null} effectiveStatus
 * @property {string|null} creativeId
 */

/**
 * Normalized Meta ad creative.
 * @typedef {object} Creative
 * @property {string} id
 * @property {string|null} name
 * @property {string|null} title
 * @property {string|null} body
 * @property {string|null} imageUrl
 * @property {string|null} videoId
 * @property {string|null} callToActionType
 * @property {string|null} linkUrl
 * @property {string|null} urlTags
 */

/**
 * A single action metric (e.g. `lead`, `link_click`, `purchase`).
 * @typedef {{type: string, value: number}} InsightAction
 */

/**
 * Normalized Meta insights (reporting) row.
 * @typedef {object} Insight
 * @property {string|null} dateStart
 * @property {string|null} dateStop
 * @property {string|null} campaignId
 * @property {string|null} adsetId
 * @property {string|null} adId
 * @property {number} spend
 * @property {number} impressions
 * @property {number} reach
 * @property {number} clicks
 * @property {number} ctr
 * @property {number} cpc
 * @property {number} cpm
 * @property {number} frequency
 * @property {InsightAction[]} actions
 * @property {number|null} roas Return on ad spend from `purchase_roas`, when available.
 */

/**
 * A single submitted field within a lead.
 * @typedef {{name: string, values: string[]}} LeadFieldEntry
 */

/**
 * Normalized Meta lead (a form submission).
 * @typedef {object} Lead
 * @property {string} id
 * @property {string|null} createdTime
 * @property {string|null} adId
 * @property {string|null} formId
 * @property {string|null} campaignId
 * @property {LeadFieldEntry[]} fieldData
 */

/**
 * Normalized Meta lead generation form.
 * @typedef {object} LeadForm
 * @property {string} id
 * @property {string} name
 * @property {string|null} status
 * @property {number|null} leadsCount
 */

module.exports = {};
