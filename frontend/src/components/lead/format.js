// Small helpers shared by the lead page's parts.

export const SOURCE_LABELS = { meta: 'Meta', web: 'Web' };

export const DEAL_OUTCOME = {
  won: { label: 'Won', cls: 'status-won' },
  lost: { label: 'Lost', cls: 'status-lost' },
  open: { label: 'Open', cls: 'status-pipeline' },
};

/** "25 Sep 2026, 2:01 pm" — the page's one date format. */
export function shortDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d
    .toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`;
}

export function scoreOf(call) {
  return call.grade && Number.isFinite(call.grade.score) ? call.grade.score : null;
}

/** Mean of the graded calls, rounded; null when none are graded. */
export function averageScore(calls) {
  const scores = calls.map(scoreOf).filter((n) => n != null);
  return scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
}
