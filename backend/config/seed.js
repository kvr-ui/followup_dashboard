const bcrypt = require('bcryptjs');

const User = require('../models/User');

const lower = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

// A user "has no email" when the field is absent (or, defensively, null/empty).
const NO_EMAIL = { $or: [{ email: { $exists: false } }, { email: null }, { email: '' }] };

// Ensure an admin account exists on startup. Credentials come from env,
// falling back to sensible defaults for local development.
async function seedAdmin() {
  const existing = await User.findOne({ role: 'admin' });
  if (existing) return;

  const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const name = process.env.ADMIN_NAME || 'Administrator';
  const adminEmail = lower(process.env.ADMIN_EMAIL);
  const ownerEmail = adminEmail || null;

  const passwordHash = await bcrypt.hash(password, 10);
  const doc = { name, username, passwordHash, role: 'admin', ownerEmail };
  // Omit `email` entirely when ADMIN_EMAIL is unset: an explicit null would be
  // indexed by the sparse unique index and collide with other email-less users.
  if (adminEmail) doc.email = adminEmail;
  await User.create(doc);

  console.log(`Seeded admin user '${username}' (change the password after first login)`);
}

// Give `user` the login email `email`, unless another user already holds it.
// Never throws on a duplicate: logs a warning and skips. Returns true if set.
async function assignEmail(user, email) {
  const taken = await User.exists({ email, _id: { $ne: user._id } });
  if (taken) {
    console.warn(
      `Email backfill: skipped user '${user.username}' — email '${email}' is already used by another user`
    );
    return false;
  }
  try {
    // Filter on "still has no email" so a concurrent boot cannot overwrite one.
    const res = await User.updateOne({ _id: user._id, ...NO_EMAIL }, { $set: { email } });
    if (res.modifiedCount) {
      console.log(`Email backfill: set email '${email}' on user '${user.username}'`);
      return true;
    }
    return false;
  } catch (err) {
    if (err && err.code === 11000) {
      console.warn(
        `Email backfill: skipped user '${user.username}' — email '${email}' is already used by another user`
      );
      return false;
    }
    throw err;
  }
}

// Idempotent: populate the login `email` for existing users from their
// ownerEmail, and for the configured admin from ADMIN_EMAIL. Users that already
// have an email are never touched, so later runs change nothing.
async function backfillUserEmails() {
  const users = await User.find({ ...NO_EMAIL, ownerEmail: { $nin: [null, ''] } })
    .select('_id username ownerEmail')
    .lean();
  for (const u of users) {
    const email = lower(u.ownerEmail);
    if (email) await assignEmail(u, email);
  }

  // Admin special case: no admin has a login email yet, but ADMIN_EMAIL is set.
  const adminEmail = lower(process.env.ADMIN_EMAIL);
  if (!adminEmail) return;
  const adminHasEmail = await User.exists({ role: 'admin', email: { $nin: [null, ''] } });
  if (adminHasEmail) return;
  const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
  const admin = await User.findOne({ role: 'admin', username, ...NO_EMAIL })
    .select('_id username')
    .lean();
  if (admin) await assignEmail(admin, adminEmail);
}

module.exports = seedAdmin;
module.exports.backfillUserEmails = backfillUserEmails;
