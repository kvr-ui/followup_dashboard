const bcrypt = require('bcryptjs');

const User = require('../models/User');

// Ensure an admin account exists on startup. Credentials come from env,
// falling back to sensible defaults for local development.
async function seedAdmin() {
  const existing = await User.findOne({ role: 'admin' });
  if (existing) return;

  const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const name = process.env.ADMIN_NAME || 'Administrator';
  const ownerEmail = process.env.ADMIN_EMAIL
    ? process.env.ADMIN_EMAIL.toLowerCase()
    : null;

  const passwordHash = await bcrypt.hash(password, 10);
  await User.create({ name, username, passwordHash, role: 'admin', ownerEmail });

  console.log(`Seeded admin user '${username}' (change the password after first login)`);
}

module.exports = seedAdmin;
