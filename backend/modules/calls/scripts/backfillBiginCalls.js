// One-time import of older Bigin calls, so the Funnel's SQL count has history.
//
//   node modules/calls/scripts/backfillBiginCalls.js [YYYY-MM-DD]   (from backend/)
//
// The scheduler's Bigin poll only ever looked back from when it was switched on
// (early August), and caps itself at 20 pages. This walks Bigin's whole Calls
// module with page tokens and upserts every call on or after the given IST date
// (default 2026-06-01) through the same upsertBiginCall the poll uses — so rows
// are deduped against TeleCMI twins exactly as live ones are, get the Bigin
// contact id + duration the Funnel reads, and are stored with transcription
// 'skipped' (no AI cost).
//
// Safe to re-run: every write is keyed on the Bigin call id.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });

const mongoose = require('mongoose');
const zoho = require('../../../services/zoho');
const Call = require('../models/Call');
const { upsertBiginCall, extensionsByEmail } = require('../services/biginCalls');
const { buildLeadIndex } = require('../services/callStore');

const SINCE = process.argv[2] || '2026-06-01';

async function run() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(SINCE)) throw new Error('Date must be YYYY-MM-DD');
  if (!zoho.isConfigured()) throw new Error('Zoho is not configured — check backend/.env');
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set — check backend/.env');
  await mongoose.connect(process.env.MONGO_URI);

  const cutoff = new Date(`${SINCE}T00:00:00+05:30`).getTime();
  const leadIndex = await buildLeadIndex();
  const extByEmail = extensionsByEmail();
  // Calls a previous (interrupted) run already tagged: skip them, so a re-run
  // only pays for what is missing.
  const done = new Set(
    (await Call.find({ biginContactId: { $ne: null } }, { biginCallId: 1 }).lean()).map((c) => c.biginCallId)
  );
  const tally = { seen: 0, inWindow: 0, skipped: 0, created: 0, updated: 0, linked: 0, failed: 0 };

  let page = 1;
  let pageToken = null;
  // Bounded so a paging bug cannot spin forever against Zoho's rate limit.
  for (let i = 0; i < 300; i += 1) {
    const qs = pageToken ? `page_token=${encodeURIComponent(pageToken)}` : `page=${page}`;
    const r = await zoho.apiGet(`/Calls?per_page=200&${qs}`);
    if (!r.ok) throw new Error(r.error || 'Calls fetch failed');
    const rows = (r.json && r.json.data) || [];
    tally.seen += rows.length;

    for (const row of rows) {
      const t = new Date(row.Call_Start_Time || row.Created_Time).getTime();
      if (!t || t < cutoff) continue;
      tally.inWindow += 1;
      if (done.has(String(row.id))) {
        tally.skipped += 1;
        continue;
      }
      try {
        const { action } = await upsertBiginCall(row, leadIndex, extByEmail);
        tally[action] += 1;
      } catch (err) {
        tally.failed += 1;
        console.warn(`  call ${row.id}: ${err.message}`);
      }
    }
    console.log(`  page ${page}: ${rows.length} calls (seen ${tally.seen}, in window ${tally.inWindow})`);

    const info = (r.json && r.json.info) || {};
    if (!info.more_records) break;
    pageToken = info.next_page_token || null;
    page += 1;
  }

  console.log('Done:', tally);
}

run()
  .catch((err) => {
    console.error('Backfill failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
