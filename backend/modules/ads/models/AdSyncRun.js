const mongoose = require('mongoose');
const { applyJsonTransform, model } = require('./_shared');

// Audit trail for the Meta ads sync: one document per run.
//
// Named AdSyncRun, not SyncRun, so it is unmistakably separate from the
// dashboard's SyncState — SyncState is a per-job cursor that moves forward,
// this is an append-only log of what each run did.
const adSyncRunSchema = new mongoose.Schema({
  // campaigns | adsets | ads | creatives | insights | leads | all
  resource: { type: String, required: true },
  status: { type: String, required: true }, // running | success | error
  recordsUpserted: { type: Number, default: 0 },
  error: String,
  startedAt: { type: Date, default: Date.now },
  finishedAt: Date,
});

adSyncRunSchema.index({ resource: 1, startedAt: 1 });
applyJsonTransform(adSyncRunSchema);

module.exports = model('AdSyncRun', adSyncRunSchema);
