// Small helpers shared by the lead page's parts.

export { SOURCE_LABELS } from '../../labels';

export const DEAL_OUTCOME = {
  won: { label: 'Won', cls: 'status-won' },
  lost: { label: 'Lost', cls: 'status-lost' },
  open: { label: 'Open', cls: 'status-pipeline' },
};

/** "25 Sep 2026, 2:01 pm" — the page's one date format, shared with every other tab. */
export { formatDateTime as shortDateTime } from '../../format';

export function scoreOf(call) {
  return call.grade && Number.isFinite(call.grade.score) ? call.grade.score : null;
}

/** Mean of the graded calls, rounded; null when none are graded. */
export function averageScore(calls) {
  const scores = calls.map(scoreOf).filter((n) => n != null);
  return scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
}
