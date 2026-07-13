const mongoose = require('mongoose');

// A per-job ingest cursor.
//
// `lastModified` means: we have successfully ingested everything Bigin/TeleCMI
// modified up to this instant. It only moves forward on a SUCCESSFUL poll, so a
// crash, a restart, or a failed API call leaves it where it was and the next
// poll simply reaches further back. That is what makes a missed webhook
// recoverable no matter how long we were down.
const syncStateSchema = new mongoose.Schema(
  {
    job: { type: String, required: true, unique: true, index: true }, // 'calls' | 'deals' | 'tasks'
    lastModified: { type: Date, default: null },
    lastRunAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SyncState', syncStateSchema);
