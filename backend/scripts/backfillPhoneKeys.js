// Backfill Task.phoneKey — the fallback key that matches a contact to an ad lead.
//
//   node backend/scripts/backfillPhoneKeys.js
//
// New contacts get their key on write (services/taskStore.js), but the thousands
// already in the database predate the field. Without this they can never match a
// Meta or web lead by phone. Idempotent — a second run reports 0 updated.
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Task = require('../models/Task');
const { phoneKey } = require('../utils/phone');

async function run() {
  await connectDB();

  let scanned = 0;
  let updated = 0;
  let skipped = 0; // no phone at all, or fewer than 10 digits

  const cursor = Task.find({}, { phone: 1, phoneKey: 1, 'body.Who_Id.phone': 1 })
    .lean()
    .cursor();

  for (let t = await cursor.next(); t; t = await cursor.next()) {
    scanned += 1;

    // The contact's phone lives in the column when enrichment ran, and only in the
    // raw webhook body when it didn't — check both before calling it unusable.
    const raw = t.phone || (t.body && t.body.Who_Id && t.body.Who_Id.phone) || null;
    const key = phoneKey(raw);

    if (!key) {
      skipped += 1;
    } else if (key !== t.phoneKey) {
      // Only write on a real change, so the second run is a pure no-op.
      await Task.updateOne({ _id: t._id }, { $set: { phoneKey: key } });
      updated += 1;
    }

    if (scanned % 200 === 0) process.stdout.write(`  scanned: ${scanned}\r`);
  }

  console.log(
    `\nScanned ${scanned} task(s): ${updated} updated, ${skipped} skipped (no usable phone), ` +
      `${scanned - updated - skipped} already correct.`
  );
  await mongoose.connection.close();
}

run().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
