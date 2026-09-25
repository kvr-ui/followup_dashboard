// Rupee and month formatting shared by the lead page's acquisition and deal panels.

// Rupees the way the retired CRM showed them: Indian digit grouping, so
// 146521.8 reads ₹1,46,521.80 rather than ₹146,521.80.
const RUPEES = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Full rupees, or null when the value is not a number. */
export function rupees(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? RUPEES.format(n) : null;
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** '2026-07' → 'Jul 2026'. Anything else is shown as it arrived. */
export function monthLabel(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) return month || '—';
  const name = MONTH_NAMES[Number(m[2]) - 1];
  return name ? `${name} ${m[1]}` : month;
}
