const mongoose = require('mongoose');

const MONGO_URI =
  process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/followup_dashboard';

async function connectDB() {
  mongoose.connection.on('connected', () => {
    console.log('MongoDB connected');
  });
  mongoose.connection.on('error', (err) => {
    console.error('MongoDB connection error:', err.message);
  });

  await mongoose.connect(MONGO_URI);
}

module.exports = connectDB;
