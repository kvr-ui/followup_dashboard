require('dotenv').config();

const app = require('./app');
const connectDB = require('./config/db');
const seedAdmin = require('./config/seed');
const Task = require('./models/Task');
const callJobs = require('./modules/calls/services/scheduler');
const { warmTaskCache } = require('./controllers/taskController');

const PORT = process.env.PORT || 3000;

connectDB()
  .then(seedAdmin)
  .then(() => Task.syncIndexes()) // build the contact-id index (autoIndex is off in prod)
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
      callJobs.start(); // reconcile polls + transcription worker
      warmTaskCache().catch((e) => console.warn('task cache warm failed:', e.message));
    });
  })
  .catch((err) => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });
