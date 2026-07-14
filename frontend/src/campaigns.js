// Shared bits for the campaigns views. Formatting and vocabulary only — the API
// calls themselves go through api() like everywhere else in the app.

/** Percentages, rendered the way the server computes them. */
export function pct(n) {
  if (n === null || n === undefined) return '—';
  return `${n}%`;
}

/** Money, when it isn't rupees. cost.js can be pointed at another currency. */
export function money(n, currency = 'INR') {
  if (n === null || n === undefined) return '—';
  if (currency === 'INR') {
    return `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  }
  return `${currency} ${Number(n).toFixed(2)}`;
}

/**
 * The colour of each funnel state, ordered by intent.
 *
 * Green is a click, not a read — because a click is the only signal WhatsApp gives
 * you that someone actually WANTED something, and the dashboard should draw the eye
 * to it. A read is amber: it might mean they looked, and it might just mean they have
 * blue ticks switched on.
 */
export const STATE_COLOR = {
  replied: 'var(--green)',
  clicked_no_reply: 'var(--green)',
  read_no_click: 'var(--amber)',
  delivered_not_read: 'var(--slate)',
  sent_not_delivered: 'var(--slate)',
  failed: 'var(--red)',
  skipped: 'var(--muted)',
  queued: 'var(--muted)',
};

export const STATUS_BADGE = {
  draft: 'badge badge-normal',
  scheduled: 'badge status-in-progress',
  sending: 'badge status-in-progress',
  paused: 'badge badge-normal',
  completed: 'badge badge-low',
  cancelled: 'badge badge-normal',
  failed: 'badge badge-high',
};

/** WhatsApp bills per conversation, and marketing costs ~7x utility in India. */
export const TEMPLATE_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'];

export function relative(date) {
  if (!date) return '—';
  const ms = Date.now() - new Date(date).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** "in 3 days", for a drip step that hasn't fired yet. */
export function until(date) {
  if (!date) return '—';
  const ms = new Date(date).getTime() - Date.now();
  if (ms <= 0) return 'due now';
  const hrs = Math.round(ms / 3600000);
  if (hrs < 24) return `in ${hrs}h`;
  return `in ${Math.round(hrs / 24)}d`;
}

/** Format an hour bucket for the best-send-time chart. */
export function hourLabel(h) {
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}
