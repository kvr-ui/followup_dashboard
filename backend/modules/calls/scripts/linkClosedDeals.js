// Link TeleCMI calls to Bigin "Closed with Sale" deals.
//
//  - Fetches every won deal, resolves its contact's phone (from our leads, and
//    from Bigin for contacts we never imported).
//  - Attaches the deal to every call for that contact.
//  - Marks ONLY won-deal calls as `pending` transcription. Everything else is
//    `skipped`, so we never spend money transcribing irrelevant calls.
//  - Derives the TeleCMI agent-extension -> salesperson mapping automatically.
//
// Usage: node modules/calls/scripts/linkClosedDeals.js
require('dotenv').config();

const mongoose = require('mongoose');
const connectDB = require('../../../config/db');
const Task = require('../../../models/Task');
const Call = require('../models/Call');
const { key10 } = require('../services/callStore');
const { buildWonPhoneMap } = require('../services/dealSync');

const MIN_DURATION = Number(process.env.TELECMI_MIN_DURATION_SEC || 30);

async function run() {
  await connectDB();
  await Call.syncIndexes();

  console.log('Fetching "Closed with Sale" deals from Bigin...');
  const { byPhone, dealCount, contactCount, missingCount, fetchedFromBigin } =
    await buildWonPhoneMap();

  console.log(`  won deals: ${dealCount} | distinct contacts: ${contactCount}`);
  console.log(`  contacts not in our leads DB: ${missingCount} -> fetched from Bigin: ${fetchedFromBigin}`);
  console.log(`  phone numbers resolved: ${byPhone.size}\n`);

  const calls = await Call.find({});
  let linked = 0;
  let pending = 0;
  let skipped = 0;

  for (const call of calls) {
    const deal = byPhone.get(key10(call.to)) || byPhone.get(key10(call.from)) || null;

    call.isClosedWon = Boolean(deal);
    call.deal = deal;
    if (deal) linked += 1;

    // Never disturb work already done / in flight.
    if (call.transcriptionStatus === 'done' || call.transcriptionStatus === 'processing') {
      await call.save();
      continue;
    }

    const worthIt = Boolean(deal) && call.hasRecording && call.duration >= MIN_DURATION;
    call.transcriptionStatus = worthIt ? 'pending' : 'skipped';
    if (worthIt) pending += 1;
    else skipped += 1;

    await call.save();
  }

  // ---- Derive the agent extension -> salesperson mapping ----
  // For calls matched to a lead, look at that lead's owner and take the majority.
  const matched = await Call.find({ leadId: { $ne: null } }, { agentExt: 1, leadId: 1 }).lean();
  const leadIds = [...new Set(matched.map((c) => String(c.leadId)))];
  const leads = await Task.find({ _id: { $in: leadIds } }, { 'body.Owner': 1 }).lean();
  const ownerOfLead = new Map(
    leads.map((l) => [String(l._id), (l.body && l.body.Owner && l.body.Owner.email) || null])
  );

  const tally = {};
  for (const c of matched) {
    const owner = ownerOfLead.get(String(c.leadId));
    if (!c.agentExt || !owner) continue;
    tally[c.agentExt] = tally[c.agentExt] || {};
    tally[c.agentExt][owner] = (tally[c.agentExt][owner] || 0) + 1;
  }

  const mapping = [];
  console.log('=== DERIVED AGENT MAPPING ===');
  for (const [ext, owners] of Object.entries(tally)) {
    const ranked = Object.entries(owners).sort((a, b) => b[1] - a[1]);
    const [best, n] = ranked[0];
    const total = ranked.reduce((a, [, v]) => a + v, 0);
    const pct = Math.round((n / total) * 100);
    console.log(`  ${ext} -> ${best}  (${n}/${total} calls, ${pct}% confidence)`);
    mapping.push(`${ext}=${best}`);
  }
  console.log(`\n  Add to .env:\n  TELECMI_AGENTS=${mapping.join(',')}\n`);

  // ---- Summary ----
  const totalMin = (
    await Call.aggregate([
      { $match: { transcriptionStatus: 'pending' } },
      { $group: { _id: null, s: { $sum: '$duration' } } },
    ])
  )[0];
  const mins = Math.round((totalMin ? totalMin.s : 0) / 60);

  console.log('=== RESULT ===');
  console.log(`  total calls: ${calls.length}`);
  console.log(`  linked to a won deal: ${linked}`);
  console.log(`  queued for transcription: ${pending}`);
  console.log(`  skipped (not a won deal / too short): ${skipped}`);
  console.log(`  audio to transcribe: ${mins} min = ${(mins / 60).toFixed(1)} hours`);
  console.log(`  est. ElevenLabs cost: ~$${((mins / 60) * 0.4).toFixed(2)}`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Link failed:', err.message);
  process.exit(1);
});
