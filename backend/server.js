require('dotenv').config();

const app = require('./app');
const connectDB = require('./config/db');
const seedAdmin = require('./config/seed');
const Task = require('./models/Task');
const SyncState = require('./models/SyncState');
const Call = require('./modules/calls/models/Call');
const Deal = require('./modules/calls/models/Deal');
const Contact = require('./modules/campaigns/models/Contact');
const CampaignMessage = require('./modules/campaigns/models/CampaignMessage');
const MessageEvent = require('./modules/campaigns/models/MessageEvent');
const Suppression = require('./modules/campaigns/models/Suppression');
const WatiWebhook = require('./modules/campaigns/models/WatiWebhook');
const callJobs = require('./modules/calls/services/scheduler');
const campaignJobs = require('./modules/campaigns/services/scheduler');
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
  // Campaigns. Three of these indexes are not optimisations, they are correctness:
  // Contact.phoneKey (one row per number), CampaignMessage (campaignId, contactId)
  // (a contact cannot receive the same campaign twice, which is what makes the sender
  // safe to retry), and MessageEvent (watiMessageId, type) (a retried webhook cannot
  // double-count a read). autoIndex is off in prod, so without these lines they never
  // get built and all three guarantees quietly evaporate.
  .then(() => Contact.syncIndexes())
  .then(() => CampaignMessage.syncIndexes())
  .then(() => MessageEvent.syncIndexes())
  .then(() => Suppression.syncIndexes())
  .then(() => WatiWebhook.syncIndexes())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
      callJobs.start(); // reconcile polls + transcription worker
      taskJobs.start(); // reconcile poll for Bigin tasks (the webhook's safety net)
      campaignJobs.start(); // campaign send queue + drip sequences

      if (!process.env.PUBLIC_BASE_URL) {
        console.warn(
          'PUBLIC_BASE_URL is not set — campaign links will NOT be tracked. Clicks are the only real intent signal WhatsApp gives you; without this, campaigns still send but you will have no click data.'
        );
      }
      if (!process.env.WATI_WEBHOOK_TOKEN) {
        console.warn(
          'WATI_WEBHOOK_TOKEN is not set — /webhook/wati is open to anyone who guesses the URL, and they could post fake delivery events.'
        );
      }

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
