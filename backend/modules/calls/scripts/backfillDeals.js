// Backfill Bigin deals into our deals collection and tag each contact's calls
// with the outcome.
//
//   node modules/calls/scripts/backfillDeals.js                 # closed deals (won + lost), as before
//   node modules/calls/scripts/backfillDeals.js --scope=open    # open deals that have a contact
//   node modules/calls/scripts/backfillDeals.js --scope=all     # both
//   node modules/calls/scripts/backfillDeals.js --scope=open --dry-run
//
// WHY OPEN DEALS ARE A SEPARATE SCOPE
// -----------------------------------
// The original July run imported closed deals only, and the reconcile poll only
// sees deals modified after its cursor. So an open deal untouched since before
// the poll started never reached the mirror — and Campaigns Core, which reads
// this copy to decide who is "active in sales", treated those people as free to
// message. `--scope=open` is the one-off repair; the nightly job in
// services/scheduler.js keeps it repaired. Closed deals are not re-read by
// default because every one costs a record fetch for its products.
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../../../config/db');
const zoho = require('../../../services/zoho');
const Deal = require('../models/Deal');
const Call = require('../models/Call');
const { upsertDeal, resyncOpenDeals, SCOPE } = require('../services/dealStore');

const arg = (name) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};
const DEAL_SCOPE = String(arg('scope') || 'closed').toLowerCase();
const DRY_RUN = arg('dry-run') === true;
if (!['closed', 'open', 'all'].includes(DEAL_SCOPE)) {
  console.error(`--scope must be closed, open or all (got "${DEAL_SCOPE}")`);
  process.exit(2);
}

async function backfillClosed() {
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

  const closed = all.filter((d) =>
    ['Closed with Sale', 'Closed without Sale', 'Closed Won', 'Closed Lost'].includes(d.Stage)
  );
  console.log(`Closed deals to process: ${closed.length}${DRY_RUN ? ' (dry run — not written)' : ''}`);
  if (DRY_RUN) return 0;

  let n = 0;
  let tagged = 0;
  for (const d of closed) {
    const r = await upsertDeal(d, 'backfill');
    tagged += r.tagged;
    n += 1;
    if (n % 100 === 0) console.log(`  ${n}/${closed.length}...`);
  }
  return tagged;
}

async function run() {
  await connectDB();
  await Deal.syncIndexes();
  await Call.syncIndexes();

  console.log(`Transcription scope: ${SCOPE}\nDeal scope: ${DEAL_SCOPE}${DRY_RUN ? ' (dry run)' : ''}\n`);

  let tagged = 0;
  if (DEAL_SCOPE === 'closed' || DEAL_SCOPE === 'all') tagged += await backfillClosed();
  if (DEAL_SCOPE === 'open' || DEAL_SCOPE === 'all') {
    const r = await resyncOpenDeals({ dryRun: DRY_RUN, log: console.log });
    if (r.skipped) throw new Error('ZOHO_* credentials are not set');
    console.log(`Open deals: ${r.missing} missing + ${r.changed} changed -> ${r.upserted} upserted${DRY_RUN ? ' (dry run)' : ''}`);
  }

  const won = await Deal.countDocuments({ outcome: 'won' });
  const lost = await Deal.countDocuments({ outcome: 'lost' });
  const open = await Deal.countDocuments({ outcome: 'open' });
  const callsWon = await Call.countDocuments({ outcome: 'won' });
  const callsLost = await Call.countDocuments({ outcome: 'lost' });
  const pending = await Call.countDocuments({ transcriptionStatus: 'pending' });
  const done = await Call.countDocuments({ transcriptionStatus: 'done' });

  console.log('\n=== RESULT ===');
  console.log(`  deals stored:  won ${won} | lost ${lost} | open ${open}`);
  console.log(`  calls tagged:  won ${callsWon} | lost ${callsLost}  (tagged this run: ${tagged})`);
  console.log(`  transcription: ${done} done | ${pending} pending  (scope: ${SCOPE})`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Deal backfill failed:', err.message);
  process.exit(1);
});
