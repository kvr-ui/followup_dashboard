// Stamp every existing deal with the channel on its Bigin contact.
//
//   node backend/modules/calls/scripts/backfillLeadSource.js [--dry]
//
// `dealStore.upsertDeal` writes `leadSource` / `leadSourceKey` / `socialLeadId`
// from now on, but only for deals it touches again. Deals closed before that
// change carry nothing, and they are precisely the ones the Sources tab exists to
// report on. This fills them in, once.
//
// ONE PASS OVER CONTACTS, NOT ONE CALL PER DEAL
// ---------------------------------------------
// The obvious implementation — read each deal's contact — is ~2,000 API calls at
// Zoho's 350ms spacing, twelve minutes of hammering an account that the live
// webhook path shares. The whole Contacts module is ~7,000 records and pages 200
// at a time: 35 calls, under a minute, and it gets the deals whose contact is
// shared right along with it.
//
// IDEMPOTENT. Re-runnable after every canonical-rules edit — which is the point:
// the rules live in one file (modules/ads/services/leadSourceName.js) and this is
// how an edit to them reaches history, visibly, instead of silently rewriting
// past numbers at query time.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });

const mongoose = require('mongoose');
const connectDB = require('../../../config/db');
const Deal = require('../models/Deal');
const zoho = require('../../../services/zoho');
const { canonicalSource, metaLeadId } = require('../../ads/services/leadSourceName');
const { invalidate } = require('../../ads/services/sourceRollup');

const DRY = process.argv.includes('--dry');

async function fetchAllContacts() {
  const out = [];
  let pageToken = null;
  let page = 1;

  // Bounded so a paging bug cannot spin against Zoho's rate limit forever.
  for (let i = 0; i < 100; i += 1) {
    const qs = pageToken ? `page_token=${encodeURIComponent(pageToken)}` : `page=${page}`;
    const r = await zoho.apiGet(
      `/Contacts?fields=id,Lead_Source1,leadchain2__Social_Lead_ID&per_page=200&${qs}`
    );
    if (!r.ok) throw new Error(r.error || 'Failed to fetch contacts');

    const rows = (r.json && r.json.data) || [];
    out.push(...rows);
    process.stdout.write(`\r  contacts fetched: ${out.length}`);

    const info = (r.json && r.json.info) || {};
    if (!info.more_records) break;
    if (info.next_page_token) {
      pageToken = info.next_page_token;
    } else {
      page += 1;
      pageToken = null;
    }
  }
  process.stdout.write('\n');
  return out;
}

async function run() {
  if (!zoho.isConfigured()) {
    console.error('Zoho is not configured — set ZOHO_CLIENT_ID / SECRET / REFRESH_TOKEN.');
    process.exit(1);
  }

  await connectDB();
  console.log(`\nBACKFILL: deal lead source${DRY ? '  (DRY RUN — no writes)' : ''}\n`);

  const contacts = await fetchAllContacts();
  const byId = new Map(contacts.map((c) => [String(c.id), c]));

  const deals = await Deal.find({}, { zohoId: 1, contactId: 1, leadSourceKey: 1 }).lean();
  console.log(`  deals in the mirror: ${deals.length}`);

  const ops = [];
  const counts = { updated: 0, unchanged: 0, noContact: 0, contactMissing: 0 };
  const perSource = new Map();

  for (const deal of deals) {
    if (!deal.contactId) {
      counts.noContact += 1;
      continue;
    }
    const contact = byId.get(String(deal.contactId));
    if (!contact) {
      // The deal points at a contact that is no longer in Bigin (deleted, or
      // merged away). Left alone rather than blanked — a stale attribution is
      // more useful than none, and it is visible in this count.
      counts.contactMissing += 1;
      continue;
    }

    const leadSource = contact.Lead_Source1 || null;
    const leadSourceKey = canonicalSource(leadSource);
    const socialLeadId = metaLeadId(contact.leadchain2__Social_Lead_ID);

    perSource.set(leadSourceKey, (perSource.get(leadSourceKey) || 0) + 1);

    if (deal.leadSourceKey === leadSourceKey) {
      counts.unchanged += 1;
      continue;
    }
    counts.updated += 1;
    ops.push({
      updateOne: {
        filter: { _id: deal._id },
        update: { $set: { leadSource, leadSourceKey, socialLeadId } },
      },
    });
  }

  if (ops.length && !DRY) {
    // Chunked: one bulkWrite of thousands of ops is a single huge command that
    // an M0 will reject or stall on.
    for (let i = 0; i < ops.length; i += 500) {
      await Deal.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    }
    invalidate();
  }

  console.log(`\n  updated          ${counts.updated}${DRY ? ' (would be)' : ''}`);
  console.log(`  already correct  ${counts.unchanged}`);
  console.log(`  no contact on the deal   ${counts.noContact}`);
  console.log(`  contact gone from Bigin  ${counts.contactMissing}`);

  console.log('\n  resulting channels:');
  [...perSource.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, n]) => console.log(`    ${String(n).padStart(6)}  ${k}`));

  console.log('\nDone. Open the Sources tab.\n');
  await mongoose.connection.close();
}

run().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
