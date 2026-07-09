// One-time import: pull all Tasks from Zoho Bigin into MongoDB.
// Usage: node scripts/importFromBigin.js
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Task = require('../models/Task');
const { upsertTask } = require('../services/taskStore');

const {
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_REFRESH_TOKEN,
  ZOHO_ACCOUNTS = 'https://accounts.zoho.in',
  ZOHO_API = 'https://www.zohoapis.in',
} = process.env;

async function getToken() {
  const params = new URLSearchParams({
    refresh_token: ZOHO_REFRESH_TOKEN,
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const res = await fetch(`${ZOHO_ACCOUNTS}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error('token failed: ' + JSON.stringify(json));
  return json.access_token;
}

async function run() {
  await connectDB();
  await Task.syncIndexes(); // apply the phone/dedupeKey unique index
  const token = await getToken();

  // Import oldest-first so the newest task ends up as the visible row.
  let page = 1;
  let imported = 0;
  let more = true;

  while (more) {
    const res = await fetch(
      `${ZOHO_API}/bigin/v1/Tasks?per_page=200&page=${page}&sort_by=Created_Time&sort_order=asc`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
    );
    const json = await res.json();
    const tasks = json.data || [];

    for (const rec of tasks) {
      await upsertTask(rec); // enriches + dedupes by phone
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
