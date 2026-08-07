// Seed the four UTM aliases the migrated data needs — the ones a human has
// already checked against the evidence.
//
//   node backend/scripts/seedCampaignAliases.js            # write
//   node backend/scripts/seedCampaignAliases.js --dry-run  # report only
//   node backend/scripts/seedCampaignAliases.js --force    # overwrite operator edits
//
// Step 2a of the attribution backfill (see plans/crm-integration/MIGRATION.md),
// between resolving campaigns and re-resolving them:
//
//   1.  backfillPhoneKeys.js       Task.phoneKey
//   2.  resolveLeadCampaigns.js    WebLead.resolvedCampaignId
//   2a. seedCampaignAliases.js     <- this script, then re-run step 2
//   3.  linkLeadsToTasks.js        lead <-> Task links
//   4.  attributionReport.js       read-only phase gate
//
// WHY THESE FOUR, AND HOW THE MAPPINGS WERE ESTABLISHED
// -----------------------------------------------------
// The first attribution report resolved 0 of 80 tagged web leads. The resolver was
// not at fault: every Meta campaign name carries a DDMM suffix ("Focas x Website
// Leads Campaign 2904") that the hand-written UTM tags never reproduced, so no
// normalisation could ever close the gap.
//
// The two mappings below were NOT guessed from the names looking similar. Each
// lead's `landingUrl` carries Meta's own `campaign_id=` parameter, stamped by the
// ad platform on the click, and every one of those ids was cross-checked against
// the campaign mirror:
//
//   "Website Lead Campaign x Focas"              34/34 leads -> campaign_id=120245224305490598
//                                                            = "Focas x Website Leads Campaign 2904"
//   "Focas Retargeting Campaign - Website Leads" 17/18 leads -> campaign_id=120250293479570598
//                                                            = "Focas Retargeting x Website Leads Campaign 1707"
//                                                (the 18th carried no campaign_id at all)
//
// Their `utm_term` values are the ad SET ids under those same two campaigns, which
// is independent corroboration of the same answer.
//
// The other two are mapped to NOTHING, deliberately:
//
//   "Google x Competitor Audience Campaign"  utm_source=google — Google Ads traffic.
//                                            No Meta campaign exists and none ever will.
//   "deploytest"                             utm_source=livetest — deploy smoke tests.
//
// RESOLVED BY NAME, NOT BY ID
// ---------------------------
// The campaign ids above are documentation. The script itself looks the campaigns
// up BY NAME at run time and aborts if a name matches zero or more than one
// campaign — so seeding against a database whose mirror differs from the one this
// was written for fails loudly instead of attributing leads to whatever id happens
// to be hard-coded here.
//
// Idempotent, and it will not clobber a human. A row that already exists and
// already says the same thing is left alone; a row that says something DIFFERENT
// is reported and skipped, because an operator correcting a seeded alias must not
// have their correction undone by the next re-run. `--force` overrides that.
//
// `.env` is resolved from THIS file, not from the shell's cwd. Run from the repo
// root and a bare `dotenv.config()` finds nothing, MONGO_URI falls back to the
// localhost default, and the script quietly writes to a dev database while
// reporting success against what looks like production.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const MetaCampaign = require('../modules/ads/models/MetaCampaign');
const aliasStore = require('../modules/ads/services/aliasStore');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

const ACTOR = { id: null, name: 'seedCampaignAliases.js' };

// `campaignName: null` means deliberately unmapped — the operator's recorded
// finding that this UTM has no Meta campaign, not a gap to be filled later.
const SEEDS = [
  {
    utmCampaign: 'Website Lead Campaign x Focas',
    campaignName: 'Focas x Website Leads Campaign 2904',
    note: 'Meta stamped campaign_id=120245224305490598 on all 34 landing URLs.',
  },
  {
    utmCampaign: 'Focas Retargeting Campaign - Website Leads',
    campaignName: 'Focas Retargeting x Website Leads Campaign 1707',
    note: 'Meta stamped campaign_id=120250293479570598 on 17 of 18 landing URLs.',
  },
  {
    utmCampaign: 'Google x Competitor Audience Campaign',
    campaignName: null,
    note: 'Google Ads traffic (utm_source=google). No Meta campaign exists for it.',
  },
  {
    utmCampaign: 'deploytest',
    campaignName: null,
    note: 'Deploy smoke-test data (utm_source=livetest). Not a real campaign.',
  },
];

/**
 * The campaign a seed names, or an abort.
 *
 * Zero matches and several matches are both fatal. A wrong alias is worse than a
 * missing one: it puts a confident, traceable-looking campaign — and its cost —
 * against leads that never came from it, and nothing downstream would ever
 * question it again.
 */
async function campaignIdFor(name) {
  const matches = await MetaCampaign.find({ name }, { name: 1 }).lean();
  if (matches.length === 1) return String(matches[0]._id);

  console.error(
    `\nABORTED — campaign name ${JSON.stringify(name)} matched ${matches.length} campaigns.\n\n` +
      (matches.length === 0
        ? '  The mirror does not contain it. Sync from Meta (or run the Atlas migration)\n' +
          '  and re-run. Do NOT edit this script to use an id instead — the name lookup\n' +
          '  is what stops a stale id being attached to the wrong campaign.\n'
        : `  Ambiguous: ${matches.map((m) => m._id).join(', ')}. A human has to decide which\n` +
          '  one this UTM string meant, and add that alias through /api/ads/campaign-aliases.\n')
  );
  process.exit(1);
}

/** Does the stored row already say exactly what this seed says? */
function unchanged(existing, campaignId, note) {
  return (
    String(existing.campaignId || '') === String(campaignId || '') &&
    (existing.note || null) === (note || null)
  );
}

async function run() {
  await connectDB();

  const campaigns = await MetaCampaign.estimatedDocumentCount();
  if (!campaigns) {
    console.error(
      '\nABORTED — MetaCampaign is empty, so every mapped seed would fail its name\n' +
        '  lookup. Run the Atlas migration or a Meta sync first.\n'
    );
    process.exit(1);
  }

  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'APPLY'}${FORCE ? ' (--force)' : ''} | ${campaigns} campaign(s)\n`);

  let created = 0;
  let updated = 0;
  let already = 0;
  let skipped = 0;

  for (const seed of SEEDS) {
    const key = aliasStore.keyFor(seed.utmCampaign);
    const campaignId = seed.campaignName ? await campaignIdFor(seed.campaignName) : null;
    const target = seed.campaignName
      ? `${campaignId}  (${seed.campaignName})`
      : 'NO CAMPAIGN  (deliberately unmapped)';

    const existing = await aliasStore.get(key);

    if (existing && unchanged(existing, campaignId, seed.note)) {
      already += 1;
      console.log(`  = ${JSON.stringify(seed.utmCampaign)}\n      already ${target}`);
      continue;
    }

    if (existing && !FORCE) {
      skipped += 1;
      console.log(
        `  ! ${JSON.stringify(seed.utmCampaign)}\n` +
          `      EXISTS and differs — left alone.\n` +
          `      stored: ${existing.campaignId || 'NO CAMPAIGN'}${existing.note ? ` — ${existing.note}` : ''}\n` +
          `      seed:   ${target}\n` +
          '      Re-run with --force to overwrite this operator edit.'
      );
      continue;
    }

    if (existing) updated += 1;
    else created += 1;

    console.log(`  ${existing ? '~' : '+'} ${JSON.stringify(seed.utmCampaign)}\n      -> ${target}`);
    console.log(`      key: ${key}`);

    if (!DRY_RUN) {
      await aliasStore.upsert({
        utmCampaign: seed.utmCampaign,
        campaignId,
        note: seed.note,
        actor: ACTOR,
      });
    }
  }

  console.log(
    `\n${DRY_RUN ? 'DRY RUN — nothing written.' : 'APPLIED —'} ` +
      `${created} created, ${updated} overwritten, ${already} already correct, ${skipped} left alone.`
  );
  if (DRY_RUN) console.log('Re-run without --dry-run to write.');
  console.log('\nNext: node backend/scripts/resolveLeadCampaigns.js   (then attributionReport.js)');

  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
