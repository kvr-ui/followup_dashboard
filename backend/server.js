require('dotenv').config();

const app = require('./app');
const connectDB = require('./config/db');
const seedAdmin = require('./config/seed');
const Task = require('./models/Task');

const PORT = process.env.PORT || 3000;

connectDB()
  .then(seedAdmin)
  .then(() => Task.syncIndexes()) // build the contact-id index (autoIndex is off in prod)
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });
