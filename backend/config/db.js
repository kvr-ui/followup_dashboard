const mongoose = require('mongoose');

const MONGO_URI =
  process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/followup_dashboard';

async function connectDB() {
  mongoose.connection.on('connected', () => {
    // Say WHICH database, not just that we reached one. A script whose `.env`
    // failed to load falls back to the localhost default above and then reports
    // success against what looks like production — naming the target here is the
    // one line that makes that visible before any writes happen. Read off the
    // live connection rather than parsed from MONGO_URI, so no credential can
    // reach the log.
    const { host, name } = mongoose.connection;
    console.log(`MongoDB connected: ${name} @ ${host}`);
  });
  mongoose.connection.on('error', (err) => {
    console.error('MongoDB connection error:', err.message);
  });

  await mongoose.connect(MONGO_URI);
}

module.exports = connectDB;
