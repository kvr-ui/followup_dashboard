// Backfill WebLead.resolvedCampaignId / resolvedBy — the historical leads' campaign.
//
//   node backend/scripts/resolveLeadCampaigns.js            # write
//   node backend/scripts/resolveLeadCampaigns.js --dry-run  # report only
//
// Step 2 of the attribution backfill (see plans/crm-integration/MIGRATION.md):
//
//   1.  backfillPhoneKeys.js      Task.phoneKey
//   2.  resolveLeadCampaigns.js   <- this script
//   2a. seedCampaignAliases.js    the operator's UTM aliases; re-run step 2 after
//   3.  linkLeadsToTasks.js       MetaLead.phoneKey + lead <-> Task links
//   4.  attributionReport.js      read-only phase gate
//
// New leads get resolved on write; the leads migrated out of the retired CRM's
// Atlas database predate the fields entirely. The resolver itself lives in
// modules/ads/services/campaignResolver.js — this script only walks and stores,
// so that a tuning change to the matching rules is a one-file change there.
//
// Idempotent: only writes when the resolved value differs from what is stored, so
// a second run reports 0 updated.
//
// `.env` is resolved from THIS file, not from the shell's cwd. Run from the repo
// root and a bare `dotenv.config()` finds nothing, MONGO_URI falls back to the
// localhost default, and the script quietly rewrites a dev database while
// reporting success against what looks like production. That is not a footgun a
// one-shot migration script gets to have.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const MetaCampaign = require('../modules/ads/models/MetaCampaign');
const WebLead = require('../modules/ads/models/WebLead');
const SyncState = require('../models/SyncState');
const { resolveCampaign, invalidate } = require('../modules/ads/services/campaignResolver');

const DRY_RUN = process.argv.includes('--dry-run');

// The marker other steps read to know this one has run. Kept in SyncState rather
// than a new collection: it is exactly what SyncState is — a per-job "we did this,
// at this instant" row.
const JOB = 'backfill:resolveLeadCampaigns';

/**
 * Prerequisite: there has to be a campaign list to resolve AGAINST. Running this
 * against an empty MetaCampaign collection would walk every lead, resolve nothing,
 * and leave a clean-looking "0 unresolved changes" report that is a lie — the
 * operator would conclude their UTM tags are fine when in fact the migration or
 * the Meta sync never ran. Fail loudly instead.
 */
async function requireCampaigns() {
  const campaigns = await MetaCampaign.estimatedDocumentCount();
  if (campaigns > 0) return campaigns;

  console.error(
    '\nABORTED — no campaigns to resolve against.\n\n' +
      '  MetaCampaign is empty, so every lead would resolve to nothing and the\n' +
      '  report would blame your UTM tags for a missing campaign list.\n\n' +
      '  Run the Atlas migration first (plans/crm-integration/MIGRATION.md),\n' +
      '  or sync from Meta, then re-run this script.\n'
  );
  process.exit(1);
}

async function run() {
  await connectDB();

  const campaigns = await requireCampaigns();
  invalidate(); // never resolve against an index cached before this process's data
  await WebLead.syncIndexes(); // resolvedCampaignId index

  const total = await WebLead.estimatedDocumentCount();
  console.log(
    `Mode: ${DRY_RUN ? 'DRY RUN' : 'APPLY'} | ${total} web lead(s) | ${campaigns} campaign(s)\n`
  );

  let scanned = 0;
  let updated = 0;
  let unchanged = 0;

  // Resolution method -> count, for every lead (not just the ones we wrote).
  // `alias` is an operator's mapping (models/CampaignAlias); `unmapped` is an
  // operator having recorded that a UTM has no Meta campaign at all — a resolved
  // question with the answer "none", which is why it is counted apart from both
  // the resolved and the unresolved.
  const byMethod = { id: 0, exact: 0, normalized: 0, alias: 0, unmapped: 0, unresolved: 0, 'no-utm': 0 };
  // The actionable list: distinct utm_campaign strings that matched no campaign
  // and that nobody has triaged. Deliberately-unmapped strings are NOT here —
  // leaving them on the worklist forever is what the alias table exists to end.
  const unresolvedUtms = new Map();

  // Sorted by `_id` on purpose: the loop writes to the very collection it is
  // walking, and a plain collection scan may revisit or skip a document that a
  // concurrent write moves. An `_id` index scan cannot — `_id` never changes — so
  // every lead is visited exactly once.
  const cursor = WebLead.find({}, { utmCampaign: 1, resolvedCampaignId: 1, resolvedBy: 1 })
    .sort({ _id: 1 })
    .lean()
    .cursor();

  for (let lead = await cursor.next(); lead; lead = await cursor.next()) {
    scanned += 1;

    const utm = lead.utmCampaign;
    const { campaignId, resolvedBy } = await resolveCampaign(utm);

    if (resolvedBy) {
      byMethod[resolvedBy] += 1;
    } else if (utm == null || !String(utm).trim()) {
      // No tag at all is not a tagging error — an organic visit, or a form on a
      // page nobody advertised. Counted apart so it never inflates the list of
      // ad URLs to go and fix.
      byMethod['no-utm'] += 1;
    } else {
      byMethod.unresolved += 1;
      const raw = String(utm);
      unresolvedUtms.set(raw, (unresolvedUtms.get(raw) || 0) + 1);
    }

    // Only write on a real change, so the second run is a pure no-op.
    const same =
      String(lead.resolvedCampaignId || '') === String(campaignId || '') &&
      (lead.resolvedBy || null) === (resolvedBy || null);

    if (same) {
      unchanged += 1;
    } else {
      updated += 1;
      if (!DRY_RUN) {
        await WebLead.updateOne(
          { _id: lead._id },
          { $set: { resolvedCampaignId: campaignId, resolvedBy } }
        );
      }
    }

    if (scanned % 200 === 0) process.stdout.write(`  scanned: ${scanned}\r`);
  }

  const resolved = byMethod.id + byMethod.exact + byMethod.normalized + byMethod.alias;
  const tagged = resolved + byMethod.unmapped + byMethod.unresolved;

  console.log('\n=== RESOLUTION BY METHOD ===');
  console.log(`  ${String(byMethod.id).padStart(6)}  id          (the UTM was the campaign id)`);
  console.log(`  ${String(byMethod.exact).padStart(6)}  exact       (verbatim campaign-name match)`);
  console.log(`  ${String(byMethod.normalized).padStart(6)}  normalized  (case/punctuation differences only)`);
  console.log(`  ${String(byMethod.alias).padStart(6)}  alias       (an admin mapped this UTM by hand)`);
  console.log(`  ${String(byMethod.unmapped).padStart(6)}  unmapped    (an admin recorded: no Meta campaign exists)`);
  console.log(`  ${String(byMethod.unresolved).padStart(6)}  unresolved  (tagged, matched no campaign, not yet triaged)`);
  console.log(`  ${String(byMethod['no-utm']).padStart(6)}  no-utm      (no utm_campaign on the lead at all)`);
  console.log(
    `\n  resolved: ${resolved}/${scanned} of all leads` +
      (tagged ? `, ${resolved}/${tagged} of the tagged ones (${Math.round((100 * resolved) / tagged)}%)` : '')
  );

  console.log('\n=== UNRESOLVED utm_campaign VALUES ===');
  if (!unresolvedUtms.size) {
    console.log('  (none — every tagged lead matched a campaign)');
  } else {
    console.log('  These ad URLs are tagged with something that is not a campaign name and');
    console.log('  that nobody has triaged. Fix them at source in Meta, rename the campaign');
    console.log('  to match, or — for history the fix can never reach — add an alias:');
    console.log('  scripts/seedCampaignAliases.js / POST /api/ads/campaign-aliases.\n');
    [...unresolvedUtms.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .forEach(([utm, n]) => console.log(`  ${String(n).padStart(6)}  ${JSON.stringify(utm)}`));
  }

  console.log(
    `\n${DRY_RUN ? 'DRY RUN — nothing written.' : 'APPLIED —'} ` +
      `${updated} lead(s) ${DRY_RUN ? 'would change' : 'updated'}, ${unchanged} already correct.`
  );
  if (DRY_RUN) console.log('Re-run without --dry-run to write.');

  if (!DRY_RUN) {
    await SyncState.findOneAndUpdate(
      { job: JOB },
      { $set: { lastRunAt: new Date() } },
      { upsert: true }
    );
  }

  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
