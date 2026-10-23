// One-time import: pull all Tasks from Zoho Bigin into MongoDB.
// Usage: node scripts/importFromBigin.js
//
// `.env` is resolved from THIS file, not from the shell's cwd — see the same note
// in backfillPhoneKeys.js. A bare `dotenv.config()` run from the repo root finds
// nothing and this script imports into a dev database while reporting success.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Task = require('../models/Task');
const { upsertTask } = require('../services/taskStore');
// The app's Bigin client: ZOHO_* credentials, region/product base URL, cached
// token, throttle and retry. (This script used to carry its own token refresh
// with stale env names — ZOHO_ACCOUNTS / ZOHO_API — that nothing else read.)
const zoho = require('../services/zoho');

async function run() {
  if (!zoho.isConfigured()) {
    throw new Error('ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN are not set — check backend/.env');
  }
  await connectDB();
  await Task.syncIndexes(); // apply the phone/dedupeKey unique index

  // Import oldest-first so the newest task ends up as the visible row.
  let page = 1;
  let imported = 0;
  let more = true;

  while (more) {
    const r = await zoho.apiGet(`/Tasks?per_page=200&page=${page}&sort_by=Created_Time&sort_order=asc`);
    if (!r.ok) throw new Error(r.error || `Tasks page ${page} failed`);
    const json = r.json || {};
    const tasks = json.data || [];

    for (const rec of tasks) {
      await upsertTask(rec, { enrich: true }); // enriches inline + dedupes by contact
      imported += 1;
    }

    console.log(`page ${page}: processed ${tasks.length} (total ${imported})`);
    more = json.info && json.info.more_records;
    page += 1;
  }

  const contacts = await Task.countDocuments({});
  console.log(`\nDone. Processed ${imported} tasks -> ${contacts} unique contact records.`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
