require('dotenv').config();

const app = require('./app');
const connectDB = require('./config/db');
const seedAdmin = require('./config/seed');
const Task = require('./models/Task');
const SyncState = require('./models/SyncState');
const Call = require('./modules/calls/models/Call');
const Deal = require('./modules/calls/models/Deal');
const callJobs = require('./modules/calls/services/scheduler');
const taskJobs = require('./services/taskSync');
const { warmTaskCache } = require('./controllers/taskController');
const { warm: warmJourneyCache } = require('./modules/calls/services/journeyCache');

const PORT = process.env.PORT || 3000;

connectDB()
  .then(seedAdmin)
  .then(() => Task.syncIndexes()) // build the contact-id index (autoIndex is off in prod)
  .then(() => SyncState.syncIndexes()) // unique per-job cursor
  .then(() => Call.syncIndexes()) // incl. deal.id — the journeys join depends on it
  .then(() => Deal.syncIndexes()) // incl. contactPhoneKey — the call<->deal match
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
      callJobs.start(); // reconcile polls + transcription worker
      taskJobs.start(); // reconcile poll for Bigin tasks (the webhook's safety net)

      // Warm both caches at boot. The journeys join takes ~18s cold on Atlas M0;
      // warming it here means a user never waits for it. Outside start() above,
      // so it still happens when the polls are switched off.
      warmTaskCache().catch((e) => console.warn('task cache warm failed:', e.message));
      warmJourneyCache().catch((e) => console.warn('journey cache warm failed:', e.message));
    });
  })
  .catch((err) => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });
