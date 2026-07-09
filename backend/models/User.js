const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    username: { type: String, required: true, unique: true, lowercase: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['admin', 'sales'], default: 'sales' },
    // For sales users: the Zoho `Owner.email` used to match their leads.
    ownerEmail: { type: String, lowercase: true, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
