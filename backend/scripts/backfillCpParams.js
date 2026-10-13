// Backfill WebLead.cp1 / cp2 from the stored landing URL.
//
//   node backend/scripts/backfillCpParams.js            # write
//   node backend/scripts/backfillCpParams.js --dry-run  # report only
//
// New leads get cp1 / cp2 on ingest (controllers/webLeadController.js); the ones
// captured before the fields existed still carry them inside `landingUrl`. The
// parsing lives in modules/ads/services/cpParams.js so both read the URL alike.
//
// Idempotent: only fills a field that is empty, so a second run reports 0 updated.
//
// `.env` is resolved from THIS file, not from the shell's cwd — see
// backfillPhoneKeys.js for why.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const WebLead = require('../modules/ads/models/WebLead');
const { cpFromUrl } = require('../modules/ads/services/cpParams');

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  await connectDB();

  let scanned = 0;
  let updated = 0;

  const cursor = WebLead.find(
    { landingUrl: { $regex: /[?&]cp[12]=/ } },
    { landingUrl: 1, cp1: 1, cp2: 1 }
  )
    .lean()
    .cursor();

  for (let l = await cursor.next(); l; l = await cursor.next()) {
    scanned += 1;
    const parsed = cpFromUrl(l.landingUrl);
    const set = {};
    if (parsed.cp1 && !l.cp1) set.cp1 = parsed.cp1;
    if (parsed.cp2 && !l.cp2) set.cp2 = parsed.cp2;
    if (!Object.keys(set).length) continue;

    if (!DRY_RUN) await WebLead.updateOne({ _id: l._id }, { $set: set });
    updated += 1;
  }

  console.log(
    `Scanned ${scanned} web lead(s) with cp params: ${updated} ${DRY_RUN ? 'would be ' : ''}updated, ` +
      `${scanned - updated} already filled.`
  );
  await mongoose.connection.close();
}

run().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
