const { retry } = require('../utils/Retry');
const { paginate } = require('../utils/Pagination');
const { MetaError, MetaTransientError, toMetaError } = require('../utils/Errors');

/**
 * @typedef {object} MetaClientOptions
 * @property {string} accessToken
 * @property {string} [apiVersion]
 * @property {string} [baseUrl]
 * @property {number} [maxRetries]
 * @property {number} [timeoutMs]
 */

/** @typedef {string|number|boolean|undefined|null} QueryValue */
/** @typedef {Record<string, QueryValue>} QueryParams */

const DEFAULT_API_VERSION = 'v24.0';
const DEFAULT_BASE_URL = 'https://graph.facebook.com';

/**
 * Low-level Graph API HTTP client. Handles URL building, the access token,
 * API versioning, timeouts, retries, typed error conversion, and pagination.
 * It knows nothing about campaigns, ads, or CRM concepts.
 */
class MetaClient {
  /** @param {MetaClientOptions} options */
  constructor(options) {
    if (!options.accessToken) {
      throw new Error('MetaClient requires an accessToken');
    }
    this.accessToken = options.accessToken;
    this.apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  /**
   * Build a fully-qualified Graph API URL, including the access token.
   * @param {string} path
   * @param {QueryParams} [params]
   * @returns {string}
   */
  buildUrl(path, params = {}) {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}/${this.apiVersion}${normalizedPath}`);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    url.searchParams.set('access_token', this.accessToken);
    return url.toString();
  }

  /**
   * Fetch a single object (node) from the Graph API.
   * @param {string} path
   * @param {QueryParams} [params]
   */
  async get(path, params) {
    return this.run(this.buildUrl(path, params));
  }

  /**
   * Fetch an edge (list), automatically following pagination to completion.
   * @param {string} path
   * @param {QueryParams} [params]
   * @returns {Promise<any[]>}
   */
  async getEdge(path, params) {
    const firstUrl = this.buildUrl(path, params);
    return paginate((url) => this.run(url), firstUrl);
  }

  run(url) {
    return retry(() => this.fetchJson(url), { retries: this.maxRetries });
  }

  async fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'AbortError';
      throw new MetaTransientError(
        timedOut
          ? `Meta API request timed out after ${this.timeoutMs}ms`
          : `Meta API network error: ${error?.message ?? 'unknown'}`,
        { httpStatus: 0, retryable: true, cause: error },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        if (!response.ok) {
          throw new MetaError(
            `Meta API returned a non-JSON error response (HTTP ${response.status})`,
            { httpStatus: response.status, retryable: response.status >= 500 },
          );
        }
      }
    }

    const hasErrorEnvelope = typeof body === 'object' && body !== null && 'error' in body;
    if (!response.ok || hasErrorEnvelope) {
      throw toMetaError(response.status, body);
    }

    return body;
  }
}

module.exports = { MetaClient };
