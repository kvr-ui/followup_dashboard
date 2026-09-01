// The one place VSL watch time is turned into words.
//
// The tracking tab, the lead drawer and the follow-ups column all render the same
// number, and a rep comparing two screens must not see "12.5 min" on one and
// "13 min" on the other. Same file role as adStats.js.

/** Minutes, one decimal, from seconds. */
export function formatMinutes(seconds) {
  if (!seconds) return '0';
  return String(Math.round((seconds / 60) * 10) / 10);
}

/**
 * "12.5 min (45%)" — the headline.
 *
 * Under a minute reads in seconds, because "0.4 min" is a number nobody pictures.
 * Nothing watched reads as an em dash, NOT "0 min": a lead who was sent the link
 * and never opened it has no watch time, and printing a zero makes an absence
 * look like a measurement.
 *
 * The percentage is appended only when it is above zero — vsl_events carries an
 * unsanitised percentage from the browser, so a real watch can arrive with a
 * junk 0, and "(0%)" beside 12 minutes reads as a broken player rather than
 * missing metadata.
 */
export function formatWatch(seconds, percentage) {
  if (!seconds || seconds <= 0) return '—';
  const pct = percentage > 0 ? ` (${Math.round(percentage)}%)` : '';
  if (seconds < 60) return `${Math.round(seconds)} sec${pct}`;
  return `${formatMinutes(seconds)} min${pct}`;
}

/** Bar widths only. The label always shows the real figure, however odd. */
export function clampPct(percentage) {
  if (!Number.isFinite(percentage)) return 0;
  return Math.max(0, Math.min(100, percentage));
}

// How far down the funnel a lead got. The server derives this (once, in
// modules/vsl/services/vslView.js) so the cards, the filter and the badge can
// never disagree; this table only names and explains it.
export const ENGAGEMENT = {
  watched: {
    label: 'Watched',
    hint: 'Watched at least 10% of the video, or 30 seconds of it.',
  },
  played: {
    label: 'Pressed play',
    hint: 'Started the video but did not get far into it.',
  },
  opened: {
    label: 'Opened',
    hint: 'Opened the VSL page but never pressed play.',
  },
  sent: {
    label: 'Link sent',
    hint: 'We sent the link on WhatsApp and they have not opened it.',
  },
  none: {
    label: 'No activity',
    hint: 'On the VSL list, but no link send and no activity recorded.',
  },
};

export const ENGAGEMENT_STATES = Object.keys(ENGAGEMENT);

export function engagementClass(state) {
  return `badge vsl-eng vsl-eng-${state || 'none'}`;
}

// 'played' is inclusive — a lead who watched also pressed play — so the filter
// and the summary card agree with the funnel the cards read as.
export const ENGAGEMENT_FILTERS = {
  all: () => true,
  watched: (r) => r.engagement === 'watched',
  played: (r) => r.engagement === 'played' || r.engagement === 'watched',
  opened: (r) => Boolean(r.firstOpenedAt || r.openCount > 0),
  sent: (r) => Boolean(r.linkSentAt),
  none: (r) => r.engagement === 'none',
};

export const LINK_FILTERS = {
  all: () => true,
  linked: (r) => Boolean(r.dashboard),
  unlinked: (r) => !r.dashboard,
};

/**
 * What to say about where the watch figure came from, or null when it is the
 * number we stand behind. A measurement and an inference must not look alike.
 */
export function watchBasisNote(basis) {
  if (basis === 'lead') {
    return 'Taken from the lead record rather than the event log — the VSL overwrites that value on every event, so it reflects the last session, not the longest.';
  }
  return null;
}
