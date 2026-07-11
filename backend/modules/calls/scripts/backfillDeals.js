// Backfill EVERY Bigin deal (won, lost, open) into our deals collection and
// tag each contact's calls with the outcome.
//
//   node modules/calls/scripts/backfillDeals.js
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../../../config/db');
const zoho = require('../../../services/zoho');
const Deal = require('../models/Deal');
const Call = require('../models/Call');
const { upsertDeal, SCOPE } = require('../services/dealStore');

async function run() {
  await connectDB();
  await Deal.syncIndexes();
  await Call.syncIndexes();

  console.log(`Transcription scope: ${SCOPE}\n`);
  console.log('Fetching all deals from Bigin...');

  const all = [];
  let page = 1;
  for (;;) {
    const r = await zoho.apiGet(`/Deals?per_page=200&page=${page}`);
    if (!r.ok) throw new Error(r.error || 'Failed to fetch deals');
    const rows = (r.json && r.json.data) || [];
    all.push(...rows);
    if (!r.json.info || !r.json.info.more_records) break;
    page += 1;
  }
  console.log(`  ${all.length} deals\n`);

  // Only deals that actually closed are worth resolving contacts for — an
  // "open" deal has no outcome to teach us, and each resolve costs a Zoho call.
  const closed = all.filter((d) =>
    ['Closed with Sale', 'Closed without Sale', 'Closed Won', 'Closed Lost'].includes(d.Stage)
  );
  console.log(`Closed deals to process: ${closed.length}`);

  let n = 0;
  let tagged = 0;
  for (const d of closed) {
    const r = await upsertDeal(d, 'backfill');
    tagged += r.tagged;
    n += 1;
    if (n % 100 === 0) console.log(`  ${n}/${closed.length}...`);
  }

  const won = await Deal.countDocuments({ outcome: 'won' });
  const lost = await Deal.countDocuments({ outcome: 'lost' });
  const callsWon = await Call.countDocuments({ outcome: 'won' });
  const callsLost = await Call.countDocuments({ outcome: 'lost' });
  const pending = await Call.countDocuments({ transcriptionStatus: 'pending' });
  const done = await Call.countDocuments({ transcriptionStatus: 'done' });

  console.log('\n=== RESULT ===');
  console.log(`  deals stored:  won ${won} | lost ${lost}`);
  console.log(`  calls tagged:  won ${callsWon} | lost ${callsLost}  (total tagged: ${tagged})`);
  console.log(`  transcription: ${done} done | ${pending} pending  (scope: ${SCOPE})`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Deal backfill failed:', err.message);
  process.exit(1);
});
