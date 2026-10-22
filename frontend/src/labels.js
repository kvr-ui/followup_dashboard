// Labels and badge classes that more than one screen renders.
//
// A stage that reads "SQL" in the Leads table and "Sql" in global search, or a
// source badge that says "Meta" in one place and "Meta form" in another, looks
// like two different things to the person reading it. One map each.

/** Where a lead came from, keyed by the server's `leadSource`. */
export const SOURCE_LABELS = { meta: 'Meta', web: 'Web' };

/** Funnel stage — derived server-side (leadState.funnelStage). */
export const STAGE = {
  mql: { label: 'MQL', hint: 'Marketing qualified — a form fill, ad lead or task, no call over 30s yet' },
  sql: { label: 'SQL', hint: 'Sales qualified — a call over 30s, or a deal in Bigin' },
  closed: { label: 'Closed', hint: 'Closed with sale' },
};
export const STAGES = Object.keys(STAGE);
export const STAGE_LABEL = Object.fromEntries(STAGES.map((k) => [k, STAGE[k].label]));

/** Badge class for a Meta ads sync run's status. */
export const SYNC_STATUS_CLASS = {
  success: 'badge badge-low',
  error: 'badge badge-high',
  running: 'badge badge-normal',
};

/** Badge for a call's transcription status. */
export const TRANSCRIPT_STATUS = {
  done: { cls: 'badge badge-low', label: 'transcribed' },
  pending: { cls: 'badge status-in-progress', label: 'pending' },
  failed: { cls: 'badge badge-high', label: 'failed' },
};
