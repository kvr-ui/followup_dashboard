// The one set of number and date formatters for the dashboard.
//
// Every screen used to carry its own: five rupee formatters that disagreed on
// null ("—", "", "₹0") and on lakh/crore short forms, and ten date formatters
// that mixed en-IN, the browser's locale, and three timezones. One rule now:
//
//   locale   en-IN  (Indian digit grouping: ₹1,46,521.80)
//   timezone Asia/Kolkata — the team works in IST, whatever the browser says
//   null     "—"   — a figure the server could not compute is never shown as ₹0
//
// Imports nothing, like adStats.js and vslStats.js: the frontend's only
// dependencies are React and react-dom.

export const DASH = '—';

const LOCALE = 'en-IN';
const TZ = 'Asia/Kolkata';

function asDate(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function finite(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const fmt = (options) => new Intl.DateTimeFormat(LOCALE, { timeZone: TZ, ...options });

const DATE_TIME = fmt({ day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const SHORT_DATE_TIME = fmt({ day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const DATE = fmt({ day: 'numeric', month: 'short', year: 'numeric' });
const DATE_NO_YEAR = fmt({ day: 'numeric', month: 'short' });
const TIME = fmt({ hour: 'numeric', minute: '2-digit' });

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** "25 Sep 2026, 2:01 pm" */
export function formatDateTime(value) {
  const d = asDate(value);
  return d ? DATE_TIME.format(d) : DASH;
}

/** "25 Sep, 2:01 pm" — for dense tables where the year is implied. */
export function formatShortDateTime(value) {
  const d = asDate(value);
  return d ? SHORT_DATE_TIME.format(d) : DASH;
}

/** "25 Sep 2026", or "25 Sep" with `{ year: false }`. */
export function formatDate(value, { year = true } = {}) {
  const d = asDate(value);
  return d ? (year ? DATE : DATE_NO_YEAR).format(d) : DASH;
}

/**
 * A calendar day. A bare 'YYYY-MM-DD' is a day in IST, not a UTC instant —
 * otherwise 1 Oct would print as 30 Sep for anyone west of Greenwich.
 */
export function formatDay(value) {
  if (!value) return DASH;
  const text = String(value);
  return formatDate(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00+05:30` : value);
}

/** "2:01 pm" */
export function formatTime(value) {
  const d = asDate(value);
  return d ? TIME.format(d) : DASH;
}

/** '2026-07' → 'Jul 2026'. Anything else is shown as it arrived. */
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function monthLabel(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) return month || DASH;
  const name = MONTH_NAMES[Number(m[2]) - 1];
  return name ? `${name} ${m[1]}` : month;
}

/** "3 hr ago" — for "last run" lines and activity columns. */
export function relativeTime(value) {
  const d = asDate(value);
  if (!d) return 'never';
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// ---------------------------------------------------------------------------
// Money — Indian digit grouping (2,11,681.84), two decimals where the figure
// has to agree with Ads Manager to the paisa, whole rupees for deal amounts.
// ---------------------------------------------------------------------------

const RUPEES = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const RUPEES_WHOLE = new Intl.NumberFormat(LOCALE, { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const COUNTS = new Intl.NumberFormat(LOCALE);

/** "₹1,46,521.80", or null when the value is not a number (for callers that branch). */
export function rupees(value) {
  const n = finite(value);
  return n == null ? null : RUPEES.format(n);
}

/** Money already in MAJOR units (rupees): insight spend, CPC, CPL, deal amounts. */
export function formatRupees(value) {
  return rupees(value) ?? DASH;
}

/** Money in MINOR units (paise): Meta campaign and ad-set budgets. Divide by 100. */
export function formatPaise(value) {
  const n = finite(value);
  return n == null ? DASH : RUPEES.format(n / 100);
}

/** "₹1,46,522" — whole rupees, for tables of deal amounts where paise are noise. */
export function formatRupeesWhole(value) {
  const n = finite(value);
  return n == null ? DASH : RUPEES_WHOLE.format(n);
}

/** "₹9.19L" / "₹1.20Cr" / "₹45,000" — lakhs read better than 9,19,000 on a card. */
export function formatRupeesShort(value) {
  const n = finite(value);
  if (n == null) return DASH;
  const v = Math.round(n);
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(2)}L`;
  return `${sign}₹${COUNTS.format(a)}`;
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

/** "1,23,456"; a missing count is 0, not a dash — a table of counts has no "unknown". */
export function formatCount(value) {
  const n = finite(value);
  return n == null ? '0' : COUNTS.format(n);
}

/** A percentage that already IS a percentage — Meta reports CTR as 1.23, not 0.0123. */
export function formatPct(value) {
  const n = finite(value);
  return n == null ? DASH : `${n.toFixed(2)}%`;
}
