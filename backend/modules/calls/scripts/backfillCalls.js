// One-time backfill: pull TeleCMI answered calls into MongoDB and match them
// to leads by phone number. Does NOT transcribe (that's the background worker).
//
// Usage:  node modules/calls/scripts/backfillCalls.js
// Range:  TELECMI_SYNC_FROM (default 2026-05-01) -> now
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../../../config/db');
const Call = require('../models/Call');
const telecmi = require('../services/telecmi');
const { agentMap, buildLeadIndex, upsertCall } = require('../services/callStore');

const MIN_DURATION = Number(process.env.TELECMI_MIN_DURATION_SEC || 30);

async function run() {
  if (!telecmi.isConfigured()) throw new Error('TELECMI_APP_ID / TELECMI_SECRET not set');

  await connectDB();
  await Call.syncIndexes();

  const fromStr = process.env.TELECMI_SYNC_FROM || '2026-05-01';
  const from = new Date(`${fromStr}T00:00:00Z`).getTime();
  const to = Date.now();

  console.log(`Syncing TeleCMI answered calls from ${fromStr} -> now`);
  console.log(`Skipping calls shorter than ${MIN_DURATION}s (won't be transcribed)\n`);

  const agents = agentMap();
  if (!Object.keys(agents).length) {
    console.warn('NOTE: TELECMI_AGENTS is not set — calls will have no salesperson mapped.\n');
  }

  const leadIndex = await buildLeadIndex();
  console.log(`Lead phone index: ${leadIndex.size} numbers\n`);

  let created = 0;
  let updated = 0;
  let matched = 0;

  const { total, seen } = await telecmi.forEachCall({
    from,
    to,
    type: 'answered',
    onRecord: async (row) => {
      const { call, created: isNew } = await upsertCall(row, leadIndex, agents, {
        minDurationSec: MIN_DURATION,
      });
      if (isNew) created += 1;
      else updated += 1;
      if (call.leadId) matched += 1;
    },
    onPage: ({ page, seen: s, total: t }) => {
      if (page % 10 === 0 || s >= t) console.log(`  page ${page}: ${s}/${t} calls`);
    },
  });

  const pending = await Call.countDocuments({ transcriptionStatus: 'pending' });
  const skipped = await Call.countDocuments({ transcriptionStatus: 'skipped' });
  const totalCalls = await Call.countDocuments({});

  console.log(`\nDone. Processed ${seen}/${total} calls.`);
  console.log(`  new: ${created} | updated: ${updated}`);
  console.log(`  matched to a lead: ${matched}`);
  console.log(`  stored total: ${totalCalls} | pending transcription: ${pending} | skipped: ${skipped}`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
