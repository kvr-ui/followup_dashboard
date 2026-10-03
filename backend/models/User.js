const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    username: { type: String, required: true, unique: true, lowercase: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['admin', 'sales'], default: 'sales' },
    // For sales users: the Zoho `Owner.email` used to match their leads.
    ownerEmail: { type: String, lowercase: true, default: null },
    // Login identity (Google sign-in matches on this). Deliberately separate
    // from ownerEmail, which only matches Zoho leads. NO default, and never
    // null: a sparse unique index still indexes explicit nulls, so users
    // without an email must leave the field absent or they would collide.
    email: { type: String, lowercase: true, trim: true, unique: true, sparse: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
