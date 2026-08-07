// Backfill the lead <-> Task links for every historical ad lead.
//
//   node backend/scripts/linkLeadsToTasks.js            # write
//   node backend/scripts/linkLeadsToTasks.js --dry-run  # report only
//
// Step 3 of the attribution backfill (see plans/crm-integration/MIGRATION.md):
//
//   1. backfillPhoneKeys.js      Task.phoneKey            <- REQUIRED FIRST
//   2. resolveLeadCampaigns.js   WebLead.resolvedCampaignId
//   3. linkLeadsToTasks.js       <- this script
//   4. attributionReport.js      read-only phase gate
//
// Two passes:
//
//   PASS 1  derive `phoneKey` on the leads themselves. A web lead migrated out of
//           the retired CRM has a raw `phone` and no key; a Meta lead has neither
//           — its phone is buried in the untyped instant-form `fieldData`. The
//           matcher looks leads up by an INDEXED EQUALITY on `phoneKey`, so a lead
//           with an empty key is invisible to it no matter how good its phone is.
//
//   PASS 2  run the matcher over every lead and write the link on both sides.
//
// All matching logic lives in modules/ads/services/leadLinker.js. This script only
// walks, calls it, and counts — tuning the rules is a one-file change there.
//
// Idempotent: `linkLead` compares against what is already stored and skips the
// write when nothing moved, so a second run reports 0 changed.
//
// `.env` is resolved from THIS file, not from the shell's cwd. Run from the repo
// root and a bare `dotenv.config()` finds nothing, MONGO_URI falls back to the
// localhost default, and the script quietly rewrites a dev database while
// reporting success against what looks like production. That is not a footgun a
// one-shot migration script gets to have.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Task = require('../models/Task');
const MetaLead = require('../modules/ads/models/MetaLead');
const WebLead = require('../modules/ads/models/WebLead');
const SyncState = require('../models/SyncState');
const { linkLead, phoneFromFieldData } = require('../modules/ads/services/leadLinker');
const { phoneKey } = require('../utils/phone');

const DRY_RUN = process.argv.includes('--dry-run');
const JOB = 'backfill:linkLeadsToTasks';

/**
 * Prerequisite: task 3's `backfillPhoneKeys.js` must have run.
 *
 * The matcher's phone rule is `Task.find({ phoneKey })` — an indexed equality, not
 * a scan of the raw `phone` column. A Task whose key was never derived therefore
 * matches NOTHING, and the run would finish reporting a low match rate that looks
 * like bad data when it is really a skipped step. Detected directly rather than
 * from a marker: count the Tasks that HAVE a derivable phone and no key.
 */
async function requirePhoneKeys() {
  let missing = 0;
  let example = null;

  const cursor = Task.find(
    { phoneKey: null },
    { phone: 1, 'body.Who_Id.phone': 1 }
  )
    .lean()
    .cursor();

  for (let t = await cursor.next(); t; t = await cursor.next()) {
    // Same two locations task 3's backfill reads, so this agrees with it exactly.
    const raw = t.phone || (t.body && t.body.Who_Id && t.body.Who_Id.phone) || null;
    if (!phoneKey(raw)) continue; // genuinely unusable — not a skipped step
    missing += 1;
    if (!example) example = t._id;
  }

  if (!missing) return;

  console.error(
    `\nABORTED — ${missing} Task(s) have a usable phone but no phoneKey ` +
      `(e.g. ${example}).\n\n` +
      '  The matcher joins on Task.phoneKey by indexed equality, so those contacts\n' +
      '  can never match a lead and this run would under-report the match rate.\n\n' +
      '  Run this first:\n' +
      '      node backend/scripts/backfillPhoneKeys.js\n'
  );
  process.exit(1);
}

/**
 * PASS 1 — give every lead the 10-digit key the matcher joins on.
 *
 * Web leads: from the `phone` column. Meta leads: dug out of `fieldData` by the
 * linker's `phoneFromFieldData`, which knows the dozen field names Focas's instant
 * forms have used. Only ever the one normaliser in utils/phone.js — two that drift
 * by a character stop matching silently.
 */
async function derivePhoneKeys() {
  const stats = {
    web: { scanned: 0, updated: 0, noPhone: 0 },
    meta: { scanned: 0, updated: 0, noPhone: 0 },
  };

  // Sorted by `_id` throughout this script: every loop writes to the collection it
  // is walking, and a plain collection scan may revisit or skip a document a
  // concurrent write moves. An `_id` index scan cannot — `_id` never changes.
  const webCursor = WebLead.find({}, { phone: 1, phoneKey: 1 }).sort({ _id: 1 }).lean().cursor();
  for (let lead = await webCursor.next(); lead; lead = await webCursor.next()) {
    stats.web.scanned += 1;
    const key = phoneKey(lead.phone);
    if (!key) {
      stats.web.noPhone += 1;
      continue;
    }
    if (key === lead.phoneKey) continue; // already correct — no write, so re-runs are free
    stats.web.updated += 1;
    if (!DRY_RUN) await WebLead.updateOne({ _id: lead._id }, { $set: { phoneKey: key } });
  }

  const metaCursor = MetaLead.find({}, { fieldData: 1, phoneKey: 1 }).sort({ _id: 1 }).lean().cursor();
  for (let lead = await metaCursor.next(); lead; lead = await metaCursor.next()) {
    stats.meta.scanned += 1;
    const key = phoneFromFieldData(lead.fieldData);
    if (!key) {
      stats.meta.noPhone += 1;
      continue;
    }
    if (key === lead.phoneKey) continue;
    stats.meta.updated += 1;
    if (!DRY_RUN) await MetaLead.updateOne({ _id: lead._id }, { $set: { phoneKey: key } });
  }

  return stats;
}

/**
 * Why a lead did NOT link. `linkLead` answers "linked or not" and deliberately
 * says no more — but "no" has four very different meanings to an operator, and
 * only one of them ("no key") is a data-quality problem worth chasing. Derived
 * here with plain lookups rather than by re-implementing any matching rule.
 */
async function classifyUnmatched(lead, kind) {
  const contactId = kind === 'web' && lead.biginContactId ? String(lead.biginContactId) : null;
  const key =
    lead.phoneKey || (kind === 'meta' ? phoneFromFieldData(lead.fieldData) : phoneKey(lead.phone));

  if (!contactId && !key) return 'no-key';

  if (contactId) {
    const byContact = await Task.findOne(
      { $or: [{ dedupeKey: `contact:${contactId}` }, { 'body.Who_Id.id': contactId }] },
      { _id: 1 }
    ).lean();
    // The contact exists here, so the only reason this lead is unlinked is that a
    // different lead for the same contact won it (or it is held by another Task).
    if (byContact) return 'task-found-other-lead-won';
  }

  if (!key) return 'no-matching-task';

  const rivals = await Task.find({ phoneKey: key }, { _id: 1 }).limit(2).lean();
  if (!rivals.length) return 'no-matching-task';
  // Two contacts on one handset — the matcher refuses to guess, by design.
  if (rivals.length > 1) return 'ambiguous-phone';
  return 'task-found-other-lead-won';
}

/** PASS 2 — run the matcher over one collection. */
async function linkCollection(Model, kind, projection, tally) {
  // NOT `.lean()`: the linker identifies a lead by its model name, and a lean
  // object forces it to guess from the shape of `fieldData` instead.
  const cursor = Model.find({}, projection).sort({ _id: 1 }).cursor();

  for (let lead = await cursor.next(); lead; lead = await cursor.next()) {
    tally.scanned += 1;

    // What the link looks like BEFORE the matcher runs, so "changed" is a real
    // measurement and the "zero changes on a second run" check means something.
    // A Meta lead holds no link of its own — its half lives on the Task.
    //
    // Read back rather than taken off `lead`: two leads can belong to one contact,
    // and linking the first writes the winner's link as a side effect. If that
    // winner is still sitting in the cursor's current batch, the copy we hold
    // predates its own link and would count a no-op as a change.
    const prior =
      kind === 'web'
        ? ((await Model.findOne({ _id: lead._id }, { linkedTaskId: 1 }).lean()) || {}).linkedTaskId
        : ((await Task.findOne({ linkedLeadId: lead._id }, { _id: 1 }).lean()) || {})._id;

    let result = { taskId: null, matchedBy: null };
    if (DRY_RUN) {
      // Nothing to simulate safely — `linkLead` writes. Report the current state
      // instead, which is what a dry run can honestly say.
      result = { taskId: prior || null, matchedBy: prior ? '(already linked)' : null };
    } else {
      result = await linkLead(lead);
    }

    if (result.taskId) {
      tally.matched += 1;
      tally.byRule[result.matchedBy] = (tally.byRule[result.matchedBy] || 0) + 1;
    } else {
      tally.unmatched += 1;
      const why = await classifyUnmatched(lead, kind);
      tally.byReason[why] = (tally.byReason[why] || 0) + 1;
    }

    if (String(prior || '') !== String(result.taskId || '')) tally.changed += 1;

    if (tally.scanned % 100 === 0) process.stdout.write(`  ${kind}: ${tally.scanned}\r`);
  }
}

function emptyTally() {
  return { scanned: 0, matched: 0, unmatched: 0, changed: 0, byRule: {}, byReason: {} };
}

function printTally(label, t) {
  const pct = t.scanned ? Math.round((100 * t.matched) / t.scanned) : 0;
  console.log(`\n=== ${label} ===`);
  console.log(`  scanned   : ${t.scanned}`);
  console.log(`  matched   : ${t.matched}  (${pct}%)`);
  for (const [rule, n] of Object.entries(t.byRule).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${String(n).padStart(6)}  by ${rule}`);
  }
  console.log(`  unmatched : ${t.unmatched}`);
  for (const [why, n] of Object.entries(t.byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${String(n).padStart(6)}  ${why}`);
  }
  // The idempotency signal: 0 here on a re-run means the pass wrote nothing.
  // It can read lower than `matched` on a FIRST run without anything being wrong —
  // when one contact submitted the form twice, linking the winner happens while
  // processing whichever of its leads comes first, so by the time the winner itself
  // is reached its link is already in place.
  console.log(`  links newly written : ${t.changed}`);
}

async function run() {
  await connectDB();
  await requirePhoneKeys();

  await Promise.all([WebLead.syncIndexes(), MetaLead.syncIndexes(), Task.syncIndexes()]);

  const webTotal = await WebLead.estimatedDocumentCount();
  const metaTotal = await MetaLead.estimatedDocumentCount();
  console.log(
    `Mode: ${DRY_RUN ? 'DRY RUN' : 'APPLY'} | ${webTotal} web lead(s), ${metaTotal} Meta lead(s)\n`
  );

  console.log('PASS 1 — deriving lead phone keys...');
  const keys = await derivePhoneKeys();
  console.log(
    `\n  web  : ${keys.web.scanned} scanned, ${keys.web.updated} key(s) ${DRY_RUN ? 'would be ' : ''}written, ` +
      `${keys.web.noPhone} without a usable phone`
  );
  console.log(
    `  meta : ${keys.meta.scanned} scanned, ${keys.meta.updated} key(s) ${DRY_RUN ? 'would be ' : ''}written, ` +
      `${keys.meta.noPhone} with no phone in fieldData`
  );

  console.log('\nPASS 2 — matching leads to contacts...');
  const web = emptyTally();
  const meta = emptyTally();

  await linkCollection(
    WebLead,
    'web',
    { phone: 1, phoneKey: 1, biginContactId: 1, linkedTaskId: 1, createdAt: 1 },
    web
  );
  await linkCollection(MetaLead, 'meta', { phoneKey: 1, fieldData: 1, createdTime: 1, syncedAt: 1 }, meta);

  printTally('WEB LEADS', web);
  printTally('META LEADS', meta);

  const totalScanned = web.scanned + meta.scanned;
  const totalMatched = web.matched + meta.matched;
  console.log(
    `\nOVERALL: ${totalMatched}/${totalScanned} lead(s) linked to a contact` +
      (totalScanned ? ` (${Math.round((100 * totalMatched) / totalScanned)}%)` : '')
  );

  if (!DRY_RUN) {
    const withSource = await Task.countDocuments({ leadSource: { $ne: null } });
    console.log(`${withSource} Task(s) now carry a leadSource.`);
    await SyncState.findOneAndUpdate(
      { job: JOB },
      { $set: { lastRunAt: new Date() } },
      { upsert: true }
    );
  } else {
    console.log('\nDRY RUN — nothing written. Re-run without --dry-run to write.');
  }

  await mongoose.connection.close();
}

run().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
