/**
 * Raw error envelope returned by the Graph API.
 * @typedef {{error?: {message?: string, type?: string, code?: number, error_subcode?: number,
 *   error_user_title?: string, error_user_msg?: string, fbtrace_id?: string}}} MetaErrorBody
 */

/**
 * @typedef {object} MetaErrorOptions
 * @property {number} httpStatus
 * @property {number|null} [code]
 * @property {number|null} [subcode]
 * @property {string|null} [type]
 * @property {string|null} [fbtraceId]
 * @property {boolean} [retryable] Whether the caller may safely retry the request.
 * @property {unknown} [cause]
 */

/** Base class for every error thrown by the connector. */
class MetaError extends Error {
  /**
   * @param {string} message
   * @param {MetaErrorOptions} options
   */
  constructor(message, options) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.httpStatus = options.httpStatus;
    this.code = options.code ?? null;
    this.subcode = options.subcode ?? null;
    this.type = options.type ?? null;
    this.fbtraceId = options.fbtraceId ?? null;
    this.retryable = options.retryable ?? false;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Invalid or expired access token — never retried. */
class MetaAuthError extends MetaError {}

/** Missing permission / capability for the request — never retried. */
class MetaPermissionError extends MetaError {}

/** Rate limited (HTTP 429 or a Meta throttling code) — retried. */
class MetaRateLimitError extends MetaError {}

/** Malformed or rejected request — never retried. */
class MetaValidationError extends MetaError {}

/** Temporary server-side (5xx) failure — retried. */
class MetaServerError extends MetaError {}

/** Network failure or client-side timeout — retried. */
class MetaTransientError extends MetaError {}

const RATE_LIMIT_CODES = new Set([
  4, 17, 32, 341, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80014,
]);
const AUTH_CODES = new Set([102, 190]);

/**
 * Translate an HTTP status + Graph API error body into a typed error,
 * classifying it as retryable or not per the retry strategy.
 *
 * @param {number} status
 * @param {MetaErrorBody} body
 * @returns {MetaError}
 */
function toMetaError(status, body) {
  const error = body.error ?? {};
  const code = typeof error.code === 'number' ? error.code : null;
  const message =
    error.error_user_msg ||
    error.message ||
    `Meta API request failed with HTTP ${status}`;

  const base = {
    httpStatus: status,
    code,
    subcode: error.error_subcode ?? null,
    type: error.type ?? null,
    fbtraceId: error.fbtrace_id ?? null,
  };

  if (status === 429 || (code !== null && RATE_LIMIT_CODES.has(code))) {
    return new MetaRateLimitError(message, { ...base, retryable: true });
  }
  if (code !== null && AUTH_CODES.has(code)) {
    return new MetaAuthError(message, { ...base, retryable: false });
  }
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) {
    return new MetaPermissionError(message, { ...base, retryable: false });
  }
  if (status >= 500) {
    return new MetaServerError(message, { ...base, retryable: true });
  }
  return new MetaValidationError(message, { ...base, retryable: false });
}

module.exports = {
  MetaError,
  MetaAuthError,
  MetaPermissionError,
  MetaRateLimitError,
  MetaValidationError,
  MetaServerError,
  MetaTransientError,
  toMetaError,
};
