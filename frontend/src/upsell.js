/**
 * Bigin's Up_Scale picklist reads:
 *   "Inter G1 - Closed with Sale - (Upsell - Inter G2)"
 * i.e. "<what they came for> - Closed with Sale - (Upsell - <what they left with>)".
 *
 * Only the two courses are worth a table cell, so pull them out. Both fall back to
 * null rather than guessing if the picklist ever stops following that shape — a new
 * option gets added in Bigin every few months.
 */

/** What they were upsold TO ("Inter G2"). Falls back to the raw value. */
export function upsoldTo(upScale) {
  if (!upScale) return null;
  const m = upScale.match(/\(\s*upsell\s*-?\s*(.+?)\s*\)/i);
  return m ? m[1] : upScale;
}

/** What they originally came for ("Inter G1"), or null if unparseable. */
export function upsoldFrom(upScale) {
  if (!upScale) return null;
  const m = upScale.match(/^\s*(.+?)\s*-\s*Closed/i);
  return m ? m[1] : null;
}

/** ₹ short-form — lakhs read better than 9,19,000. */
export function inr(n) {
  const v = Math.round(n || 0);
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(2)}L`;
  return `${sign}₹${a.toLocaleString('en-IN')}`;
}
