// Backfill WebLead.resolvedAdsetId / resolvedAdId — the historical leads' ad set
// and ad, from utm_term (the ad set id on our click URLs) and utm_content (the
// ad name).
//
//   node backend/scripts/resolveLeadAdEntities.js            # write
//   node backend/scripts/resolveLeadAdEntities.js --dry-run  # report only
//
// Run AFTER the Meta sync has mirrored ad sets and ads (and after
// resolveLeadCampaigns.js, whose report this one's complements). New leads get
// resolved on write; everything older predates the fields. The resolver itself
// lives in modules/ads/services/adEntityResolver.js — this script only walks and
// stores, so a tuning change to the matching rules is a one-file change there.
//
// Idempotent: only writes when the resolved value differs from what is stored, so
// a second run reports 0 updated.
//
// RENAME SAFETY: a name-matched ad (`resolvedAdBy` exact/normalized) whose ad was
// since RENAMED in Meta would re-resolve to null here. That would destroy a match
// that was correct when made — so the script never downgrades a non-null adId to
// null; it only replaces it with a different resolution or leaves it alone.
//
// `.env` is resolved from THIS file, not from the shell's cwd. Run from the repo
// root and a bare `dotenv.config()` finds nothing, MONGO_URI falls back to the
// localhost default, and the script quietly rewrites a dev database while
// reporting success against what looks like production. That is not a footgun a
// one-shot migration script gets to have.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const MetaAdset = require('../modules/ads/models/MetaAdset');
const WebLead = require('../modules/ads/models/WebLead');
const SyncState = require('../models/SyncState');
const { resolveAdEntities, invalidate } = require('../modules/ads/services/adEntityResolver');

const DRY_RUN = process.argv.includes('--dry-run');

const JOB = 'backfill:resolveLeadAdEntities';

/**
 * Prerequisite: there has to be an ad set list to resolve AGAINST. Against an
 * empty mirror every lead would resolve to nothing and the report would blame
 * the UTM tags for a sync that never ran. Fail loudly instead.
 */
async function requireAdsets() {
  const adsets = await MetaAdset.estimatedDocumentCount();
  if (adsets > 0) return adsets;

  console.error(
    '\nABORTED — no ad sets to resolve against.\n\n' +
      '  MetaAdset is empty, so every lead would resolve to nothing and the\n' +
      '  report would blame your UTM tags for a missing ad set mirror.\n\n' +
      '  Run the Meta sync first, then re-run this script.\n'
  );
  process.exit(1);
}

async function run() {
  await connectDB();

  const adsets = await requireAdsets();
  invalidate(); // never resolve against an index cached before this process's data
  await WebLead.syncIndexes(); // resolvedAdsetId / resolvedAdId indexes

  const total = await WebLead.estimatedDocumentCount();
  console.log(
    `Mode: ${DRY_RUN ? 'DRY RUN' : 'APPLY'} | ${total} web lead(s) | ${adsets} ad set(s)\n`
  );

  let scanned = 0;
  let updated = 0;
  let unchanged = 0;
  let kept = 0; // rename safety: non-null adId we refused to clear

  const adsetByMethod = { id: 0, 'ad-id': 0, exact: 0, normalized: 0, unresolved: 0, 'no-term': 0 };
  const adByMethod = { term: 0, id: 0, exact: 0, normalized: 0, unresolved: 0, 'no-content': 0 };
  // The actionable lists: distinct strings that matched nothing.
  const unresolvedTerms = new Map();
  const unresolvedContents = new Map();

  // Sorted by `_id` on purpose: the loop writes to the very collection it is
  // walking, and an `_id` index scan visits every lead exactly once.
  const cursor = WebLead.find(
    {},
    { utmTerm: 1, utmContent: 1, resolvedAdsetId: 1, resolvedAdsetBy: 1, resolvedAdId: 1, resolvedAdBy: 1 }
  )
    .sort({ _id: 1 })
    .lean()
    .cursor();

  for (let lead = await cursor.next(); lead; lead = await cursor.next()) {
    scanned += 1;

    const term = lead.utmTerm == null ? '' : String(lead.utmTerm).trim();
    const content = lead.utmContent == null ? '' : String(lead.utmContent).trim();
    const r = await resolveAdEntities(lead);

    // Rename safety — see the file header. A fresh null never clears a stored ad.
    if (!r.adId && lead.resolvedAdId) {
      r.adId = lead.resolvedAdId;
      r.adBy = lead.resolvedAdBy;
      kept += 1;
    }
    if (!r.adsetId && lead.resolvedAdsetId) {
      r.adsetId = lead.resolvedAdsetId;
      r.adsetBy = lead.resolvedAdsetBy;
    }

    if (r.adsetBy) adsetByMethod[r.adsetBy] += 1;
    else if (!term) adsetByMethod['no-term'] += 1;
    else {
      adsetByMethod.unresolved += 1;
      unresolvedTerms.set(term, (unresolvedTerms.get(term) || 0) + 1);
    }

    if (r.adBy) adByMethod[r.adBy] += 1;
    else if (!content) adByMethod['no-content'] += 1;
    else {
      adByMethod.unresolved += 1;
      if (r.adsetId) unresolvedContents.set(content, (unresolvedContents.get(content) || 0) + 1);
    }

    const same =
      String(lead.resolvedAdsetId || '') === String(r.adsetId || '') &&
      (lead.resolvedAdsetBy || null) === (r.adsetBy || null) &&
      String(lead.resolvedAdId || '') === String(r.adId || '') &&
      (lead.resolvedAdBy || null) === (r.adBy || null);

    if (same) {
      unchanged += 1;
    } else {
      updated += 1;
      if (!DRY_RUN) {
        await WebLead.updateOne(
          { _id: lead._id },
          {
            $set: {
              resolvedAdsetId: r.adsetId,
              resolvedAdsetBy: r.adsetBy,
              resolvedAdId: r.adId,
              resolvedAdBy: r.adBy,
            },
          }
        );
      }
    }

    if (scanned % 200 === 0) process.stdout.write(`  scanned: ${scanned}\r`);
  }

  const line = (n, label, note) =>
    console.log(`  ${String(n).padStart(6)}  ${label.padEnd(11)} (${note})`);

  console.log('\n=== AD SET RESOLUTION (utm_term) ===');
  line(adsetByMethod.id, 'id', 'the UTM was the ad set id');
  line(adsetByMethod['ad-id'], 'ad-id', 'the UTM was an AD id; ad set is its parent');
  line(adsetByMethod.exact, 'exact', 'verbatim ad set name match');
  line(adsetByMethod.normalized, 'normalized', 'case/punctuation differences only');
  line(adsetByMethod.unresolved, 'unresolved', 'tagged, matched no ad set');
  line(adsetByMethod['no-term'], 'no-term', 'no utm_term on the lead at all');

  console.log('\n=== AD RESOLUTION (utm_content) ===');
  line(adByMethod.term, 'term', 'utm_term named the ad outright');
  line(adByMethod.id, 'id', 'utm_content was the ad id');
  line(adByMethod.exact, 'exact', 'verbatim ad name match within the ad set');
  line(adByMethod.normalized, 'normalized', 'case/punctuation differences only');
  line(adByMethod.unresolved, 'unresolved', 'tagged, matched no ad');
  line(adByMethod['no-content'], 'no-content', 'no utm_content on the lead at all');
  if (kept) console.log(`\n  ${kept} previously-matched ad(s) kept (rename safety — never downgraded to null).`);

  const printUnresolved = (title, map, hint) => {
    console.log(`\n=== ${title} ===`);
    if (!map.size) {
      console.log('  (none)');
      return;
    }
    console.log(`  ${hint}\n`);
    [...map.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .forEach(([v, n]) => console.log(`  ${String(n).padStart(6)}  ${JSON.stringify(v)}`));
  };
  printUnresolved(
    'UNRESOLVED utm_term VALUES',
    unresolvedTerms,
    'These ad URLs carry a utm_term that is not an ad set id or name. Fix at source in Meta.'
  );
  printUnresolved(
    'UNRESOLVED utm_content VALUES (ad set known)',
    unresolvedContents,
    'The ad set resolved but utm_content matched no ad in it — likely the ad was renamed in Meta.'
  );

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
