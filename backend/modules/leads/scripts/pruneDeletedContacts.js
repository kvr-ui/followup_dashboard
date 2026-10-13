// Remove contacts deleted in Bigin from our Contact mirror — the nightly job's
// rule (services/contactPrune), run by hand.
//
//   node modules/leads/scripts/pruneDeletedContacts.js --dry-run   (from backend/)
//   node modules/leads/scripts/pruneDeletedContacts.js
//   node modules/leads/scripts/pruneDeletedContacts.js --force     # past the safety limit
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });

const mongoose = require('mongoose');
const { pruneDeletedContacts } = require('../services/contactPrune');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

async function run() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set — check backend/.env');
  await mongoose.connect(process.env.MONGO_URI);

  const r = await pruneDeletedContacts({ dryRun: DRY_RUN, force: FORCE });
  if (r.skipped) throw new Error('Zoho is not configured — check backend/.env');

  console.log(`Bigin: ${r.bigin} contacts. Mirror: ${r.mirror}. Missing from Bigin: ${r.missing.length}.`);
  if (r.missing.length) console.log(`  ${r.missing.slice(0, 20).join(', ')}${r.missing.length > 20 ? ', …' : ''}`);
  if (r.refused) console.log(`Refused: ${r.refused}. Nothing deleted.`);
  else if (DRY_RUN) console.log(`Dry run: ${r.missing.length} would be deleted.`);
  else console.log(`Deleted ${r.deleted}.`);
}

run()
  .catch((err) => {
    console.error('Prune failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
