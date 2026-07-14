// Backfill the phone match keys that cross-link calls <-> deals.
//
//   node modules/calls/scripts/backfillPhoneKeys.js
//
// Populates Call.phoneKeys and Deal.contactPhoneKey on every existing record,
// so the indexed-equality lookups (which replaced the old regex-suffix scans)
// find pre-existing calls and deals. Idempotent — safe to run more than once.
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../../../config/db');
const Call = require('../models/Call');
const Deal = require('../models/Deal');
const { phoneKey, phoneKeysOf } = require('../services/callStore');

async function run() {
  await connectDB();

  let calls = 0;
  const callCursor = Call.find({}, { leadPhone: 1, to: 1, from: 1 }).cursor();
  for (let c = await callCursor.next(); c; c = await callCursor.next()) {
    await Call.updateOne({ _id: c._id }, { $set: { phoneKeys: phoneKeysOf(c) } });
    calls += 1;
    if (calls % 200 === 0) process.stdout.write(`  calls: ${calls}\r`);
  }

  let deals = 0;
  const dealCursor = Deal.find({}, { contactPhone: 1 }).cursor();
  for (let d = await dealCursor.next(); d; d = await dealCursor.next()) {
    await Deal.updateOne(
      { _id: d._id },
      { $set: { contactPhoneKey: phoneKey(d.contactPhone) } }
    );
    deals += 1;
    if (deals % 200 === 0) process.stdout.write(`  deals: ${deals}\r`);
  }

  console.log(`\nBackfilled ${calls} call(s) and ${deals} deal(s).`);
  await mongoose.connection.close();
}

run().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
