/**
 * @typedef {object} RetryOptions
 * @property {number} [retries] Maximum retry attempts after the first try. Defaults to `3`.
 * @property {number} [baseDelayMs] Base backoff delay in ms. Defaults to `500`.
 * @property {number} [maxDelayMs] Upper bound on any single backoff delay in ms. Defaults to `15000`.
 * @property {(error: unknown, attempt: number, delayMs: number) => void} [onRetry]
 *   Invoked before each retry sleep. Useful for logging/metrics.
 */

function isRetryable(error) {
  return typeof error === 'object' && error !== null && error.retryable === true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async operation with exponential backoff + jitter.
 * Only errors flagged `retryable` (429, 5xx, network/timeout) are retried;
 * auth, permission, and validation errors fail fast.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {RetryOptions} [options]
 * @returns {Promise<T>}
 */
async function retry(fn, options = {}) {
  const retries = options.retries ?? 3;
  const baseDelay = options.baseDelayMs ?? 500;
  const maxDelay = options.maxDelayMs ?? 15000;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= retries || !isRetryable(error)) {
        throw error;
      }
      const backoff = Math.min(maxDelay, baseDelay * 2 ** attempt);
      const jitter = Math.random() * backoff * 0.25;
      const delay = Math.round(backoff + jitter);
      options.onRetry?.(error, attempt + 1, delay);
      await sleep(delay);
      attempt += 1;
    }
  }
}

module.exports = { retry };
