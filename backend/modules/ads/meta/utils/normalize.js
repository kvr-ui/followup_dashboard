/**
 * Parse a Graph API numeric string/value into a number, or `null` if absent/invalid.
 * @param {unknown} value
 * @returns {number|null}
 */
function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Like {@link toNumber} but returns `fallback` instead of `null`.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function numberOr(value, fallback) {
  const n = toNumber(value);
  return n === null ? fallback : n;
}

module.exports = { toNumber, numberOr };
