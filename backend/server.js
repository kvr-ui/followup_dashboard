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
const adJobs = require('./modules/ads/services/scheduler');
const { warmTaskCache } = require('./controllers/taskController');
const { warm: warmJourneyCache } = require('./modules/calls/services/journeyCache');

// The Meta ads mirror, listed only so their indexes get built at boot like
// everything else — MetaInsight's unique natural key especially, since that is
// what stops a re-sync duplicating a day's spend.
const adModels = [
  require('./modules/ads/models/MetaCampaign'),
  require('./modules/ads/models/MetaAdset'),
  require('./modules/ads/models/MetaAd'),
  require('./modules/ads/models/MetaCreative'),
  require('./modules/ads/models/MetaInsight'),
  require('./modules/ads/models/MetaLead'),
  require('./modules/ads/models/WebLead'),
  require('./modules/ads/models/AdSyncRun'),
];

const PORT = process.env.PORT || 3000;

connectDB()
  .then(seedAdmin)
  .then(() => Task.syncIndexes()) // build the contact-id index (autoIndex is off in prod)
  .then(() => SyncState.syncIndexes()) // unique per-job cursor
  .then(() => Call.syncIndexes()) // incl. deal.id — the journeys join depends on it
  .then(() => Deal.syncIndexes()) // incl. contactPhoneKey — the call<->deal match
  .then(() => Promise.all(adModels.map((m) => m.syncIndexes()))) // the Meta ads mirror
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
      callJobs.start(); // reconcile polls + transcription worker
      taskJobs.start(); // reconcile poll for Bigin tasks (the webhook's safety net)
      adJobs.start(); // full Meta ads sync on SYNC_INTERVAL_MINUTES

      // Warm the caches at boot. The journeys join takes ~18s cold on Atlas M0;
      // warming it here means a user never waits for it. Outside start() above,
      // so it still happens when the polls are switched off.
      warmTaskCache().catch((e) => console.warn('task cache warm failed:', e.message));
      warmJourneyCache().catch((e) => console.warn('journey cache warm failed:', e.message));

      // The cost-per-lead cache is the ads module's equivalent of the two warms
      // above, and is warmed here for the same reason. Required lazily inside a
      // guard because it belongs to the attribution services rather than to the
      // sync: a cache that is missing or unhappy is a slow first Marketing
      // request, never a failed boot.
      try {
        require('./modules/ads/services/cplCache')
          .warmCplCache()
          .catch((e) => console.warn('cpl cache warm failed:', e.message));
      } catch (e) {
        console.warn('cpl cache unavailable:', e.message);
      }
    });
  })
  .catch((err) => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });
