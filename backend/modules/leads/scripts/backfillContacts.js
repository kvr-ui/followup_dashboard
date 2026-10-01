// One-time import of every existing Bigin contact into our Contact mirror.
//
//   node modules/leads/scripts/backfillContacts.js            (from backend/)
//
// The contact webhook (POST /webhook/contact) keeps the mirror current from the
// day it is switched on; this seeds everything created before that. Safe to
// re-run: every write is an upsert on the Bigin contact id.
//
// Reads Bigin (~7k contacts, 200 per page, throttled by services/zoho), writes
// only the Contact collection.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });

const mongoose = require('mongoose');
const { apiGet, isConfigured } = require('../../../services/zoho');
const Contact = require('../models/Contact');
const { fromBiginRecord } = require('../services/contactStore');

const FIELDS = [
  'Full_Name',
  'First_Name',
  'Last_Name',
  'Phone',
  'Mobile',
  'Lead_Source1',
  'Owner',
  'Created_Time',
  'Modified_Time',
].join(',');

async function run() {
  if (!isConfigured()) throw new Error('Zoho is not configured — check backend/.env');
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set — check backend/.env');
  await mongoose.connect(process.env.MONGO_URI);

  let page = 1;
  let pageToken = null;
  let seen = 0;
  let written = 0;
  // Bounded so a paging bug cannot spin forever against Zoho's rate limit.
  for (let i = 0; i < 200; i += 1) {
    const qs = pageToken ? `page_token=${encodeURIComponent(pageToken)}` : `page=${page}`;
    const r = await apiGet(`/Contacts?fields=${FIELDS}&per_page=200&${qs}`);
    if (!r.ok) throw new Error(r.error || 'Contacts fetch failed');
    const data = (r.json && r.json.data) || [];
    seen += data.length;

    const ops = data
      .map(fromBiginRecord)
      .filter(Boolean)
      .map(({ zohoId, ...rest }) => ({
        updateOne: {
          filter: { zohoId },
          update: { $set: { ...rest, syncedBy: 'backfill' } },
          upsert: true,
        },
      }));
    if (ops.length) {
      const res = await Contact.bulkWrite(ops, { ordered: false });
      written += res.upsertedCount + res.modifiedCount;
    }
    console.log(`  page ${page}: ${data.length} contacts (total ${seen})`);

    const info = (r.json && r.json.info) || {};
    if (!info.more_records) break;
    // Bigin v2 hands out a page_token past the first 2,000 records; before
    // that (or on v1) plain page numbers work.
    pageToken = info.next_page_token || null;
    page += 1;
  }

  const total = await Contact.countDocuments();
  console.log(`Done: ${seen} contacts read from Bigin, ${written} inserted/updated, ${total} in the mirror.`);
}

run()
  .catch((err) => {
    console.error('Backfill failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
