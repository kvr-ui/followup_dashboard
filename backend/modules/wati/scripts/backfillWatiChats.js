// One-off: copy WATI chats for every Bigin contact created in the last N days.
//
//   node modules/wati/scripts/backfillWatiChats.js            # last 120 days, missing chats only
//   node modules/wati/scripts/backfillWatiChats.js --days=30 --force
//
// Read-only against WATI. Safe to re-run: it skips chats already stored unless
// --force, and a rate limit just stops it — run it again later to continue.
require('dotenv').config();
const mongoose = require('mongoose');
const { backfill } = require('../services/watiSync');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}`));
  if (!hit) return null;
  const [, value] = hit.split('=');
  return value === undefined ? true : value;
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const t0 = Date.now();
  const result = await backfill({ days: Number(arg('days')) || 120, force: Boolean(arg('force')) });
  console.log(`[wati backfill] done in ${Math.round((Date.now() - t0) / 1000)}s`, result);
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
