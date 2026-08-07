// The attribution phase gate. READ-ONLY — it opens no write, anywhere.
//
//   node backend/scripts/attributionReport.js
//
// Step 4, and the last, of the attribution backfill (see
// plans/crm-integration/MIGRATION.md):
//
//   1.  backfillPhoneKeys.js      Task.phoneKey
//   2.  resolveLeadCampaigns.js   WebLead.resolvedCampaignId   <- REQUIRED FIRST
//   2a. seedCampaignAliases.js    the operator's UTM aliases; re-run step 2 after
//   3.  linkLeadsToTasks.js       lead <-> Task links          <- REQUIRED FIRST
//   4.  attributionReport.js      <- this script
//
// This is where a human decides whether the matching rules are good enough on real
// data BEFORE any UI is built on top of them. Every number below answers one
// question: if the Acquisition panel shipped tomorrow, how often would it have
// something true to say?
//
// A low resolution rate is not a bug in this script — it is the finding. The two
// lists at the end (unresolved UTM strings, and the reasons leads went unlinked)
// say which of the resolver, the ad tagging, or the data itself needs the work.
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
const CampaignAlias = require('../modules/ads/models/CampaignAlias');
const MetaCampaign = require('../modules/ads/models/MetaCampaign');
const MetaLead = require('../modules/ads/models/MetaLead');
const WebLead = require('../modules/ads/models/WebLead');
const SyncState = require('../models/SyncState');

const RESOLVE_JOB = 'backfill:resolveLeadCampaigns';
const LINK_JOB = 'backfill:linkLeadsToTasks';

/**
 * Prerequisites. Read from the markers the two write scripts leave rather than
 * inferred from the data, because "0 resolved" is a legitimate outcome AND what a
 * never-run backfill looks like — indistinguishable from the numbers alone, and
 * the entire point of this report is that a human trusts the numbers.
 */
async function requireBackfills() {
  const states = await SyncState.find({ job: { $in: [RESOLVE_JOB, LINK_JOB] } }).lean();
  const seen = new Map(states.map((s) => [s.job, s.lastRunAt]));

  const missing = [];
  if (!seen.get(RESOLVE_JOB)) missing.push(['node backend/scripts/resolveLeadCampaigns.js', RESOLVE_JOB]);
  if (!seen.get(LINK_JOB)) missing.push(['node backend/scripts/linkLeadsToTasks.js', LINK_JOB]);

  if (missing.length) {
    console.error(
      '\nABORTED — the backfills this report describes have not run.\n\n' +
        '  Without them every figure below would read as zero, and a zero here is\n' +
        '  indistinguishable from "the attribution rules found nothing" — which is\n' +
        '  the one conclusion this report exists to let you draw safely.\n\n' +
        '  Run, in order:\n' +
        missing.map(([cmd]) => `      ${cmd}`).join('\n') +
        '\n'
    );
    process.exit(1);
  }

  return seen;
}

function pct(n, total) {
  return total ? `${Math.round((100 * n) / total)}%` : 'n/a';
}

function line(label, value, extra) {
  console.log(`  ${String(label).padEnd(34)} ${String(value).padStart(7)}${extra ? `  ${extra}` : ''}`);
}

function heading(title) {
  console.log(`\n=== ${title} ===`);
}

/**
 * `Task.linkedLeadId` is Mixed and points into one of two collections, so which
 * one is decided by `leadSource`. When a link predates that field being written,
 * fall back to the id SHAPE: a WebLead `_id` is an ObjectId, a MetaLead `_id` is
 * Meta's numeric string. Guarding on the shape also keeps mongoose from throwing a
 * CastError when a Meta id is handed to the WebLead model.
 */
function isObjectIdLike(id) {
  if (id instanceof mongoose.Types.ObjectId) return true;
  if (typeof id !== 'string') return false;
  return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === id;
}

async function loadLead(id, source) {
  if (source === 'meta') return MetaLead.findById(String(id), { _id: 1 }).lean();
  if (source === 'web') {
    return isObjectIdLike(id) ? WebLead.findById(id, { biginContactId: 1 }).lean() : null;
  }
  // Unknown source — decide from the id shape.
  return isObjectIdLike(id)
    ? WebLead.findById(id, { biginContactId: 1 }).lean()
    : MetaLead.findById(String(id), { _id: 1 }).lean();
}

async function run() {
  // READ-ONLY means read-only. Mongoose builds a model's declared indexes on first
  // use by default, which is a write — harmless, but this script's whole value is
  // that a nervous operator can run it against production without thinking twice.
  mongoose.set('autoIndex', false);

  await connectDB();
  const ranAt = await requireBackfills();

  console.log('\n' + '='.repeat(72));
  console.log('  ATTRIBUTION REPORT  (read-only)');
  console.log(`  generated ${new Date().toISOString()}`);
  console.log(`  campaigns resolved at ${new Date(ranAt.get(RESOLVE_JOB)).toISOString()}`);
  console.log(`  leads linked at       ${new Date(ranAt.get(LINK_JOB)).toISOString()}`);
  console.log('='.repeat(72));

  // ---- 1. Inventory -------------------------------------------------------
  const [webTotal, metaTotal, taskTotal, campaignTotal] = await Promise.all([
    WebLead.countDocuments({}),
    MetaLead.countDocuments({}),
    Task.countDocuments({}),
    MetaCampaign.countDocuments({}),
  ]);
  const leadTotal = webTotal + metaTotal;

  heading('LEADS BY TYPE');
  line('web leads', webTotal);
  line('Meta instant-form leads', metaTotal);
  line('TOTAL leads', leadTotal);
  line('contacts (Tasks)', taskTotal);
  line('campaigns available to match', campaignTotal);

  // ---- 2. Campaign resolution --------------------------------------------
  // Only web leads carry a UTM string. A Meta lead knows its campaign outright —
  // Meta stamps `campaignId` on it — so it is never "resolved" and counting it
  // here would flatter the rate.
  const methods = await WebLead.aggregate([
    { $group: { _id: '$resolvedBy', n: { $sum: 1 } } },
  ]);
  const byMethod = Object.fromEntries(methods.map((m) => [m._id || 'unresolved', m.n]));
  const resolved =
    (byMethod.id || 0) + (byMethod.exact || 0) + (byMethod.normalized || 0) + (byMethod.alias || 0);

  const taggedTotal = await WebLead.countDocuments({
    utmCampaign: { $nin: [null, ''] },
  });

  // `resolvedBy: null` covers two very different leads — one that was tagged and
  // matched nothing (a broken ad URL, actionable) and one that carried no tag at
  // all (organic, nothing to fix). Lumping them would make the tagging look twice
  // as broken as it is, so the unresolved figure counts only the tagged ones.
  //
  // 'unmapped' is excluded for the same reason from the other side: an admin has
  // looked at that UTM and recorded that no Meta campaign exists for it (Google
  // Ads traffic, test data). It has no campaign and never will, and counting it as
  // unresolved would leave it on the actionable list forever.
  const unresolvedTagged = await WebLead.countDocuments({
    resolvedCampaignId: null,
    resolvedBy: { $ne: 'unmapped' },
    utmCampaign: { $nin: [null, ''] },
  });

  heading('CAMPAIGN RESOLUTION (web leads only)');
  line('resolved by id', byMethod.id || 0, 'the UTM was the campaign id');
  line('resolved by exact name', byMethod.exact || 0, 'verbatim campaign-name match');
  line('resolved by normalized name', byMethod.normalized || 0, 'case/punctuation only');
  line('resolved by alias', byMethod.alias || 0, 'an admin mapped this UTM by hand');
  line('deliberately unmapped', byMethod.unmapped || 0, 'admin: no Meta campaign exists');
  line('unresolved (tagged, no match)', unresolvedTagged, 'not yet triaged');
  line('RESOLVED / all web leads', `${resolved}/${webTotal}`, pct(resolved, webTotal));
  line('RESOLVED / tagged web leads', `${resolved}/${taggedTotal}`, pct(resolved, taggedTotal));
  // The honest denominator for "is the matching good enough": a lead tagged with a
  // string that HAS no Meta campaign cannot be resolved by any rule, and counting
  // it against the rate measures the marketing team's channel mix, not the
  // resolver. Both figures are printed so neither can be quoted alone.
  const resolvable = taggedTotal - (byMethod.unmapped || 0);
  line('RESOLVED / resolvable tagged', `${resolved}/${resolvable}`, pct(resolved, resolvable));
  line('web leads with no utm_campaign', webTotal - taggedTotal);

  const metaWithCampaign = await MetaLead.countDocuments({ campaignId: { $ne: null } });
  if (metaTotal) {
    line('Meta leads with a campaignId', `${metaWithCampaign}/${metaTotal}`, 'stamped by Meta, not resolved');
  }

  // ---- 3. Linking ---------------------------------------------------------
  // The matching RULE is not stored on either side, so it is re-derived here from
  // the pair itself: a lead holding the contact's own Bigin id was matched by
  // identity, anything else was matched by phone. Read-only, and it agrees with
  // the linker because those are the only two rules it has.
  const linkedTasks = await Task.find(
    { linkedLeadId: { $ne: null } },
    { linkedLeadId: 1, leadSource: 1, 'body.Who_Id.id': 1 }
  ).lean();

  const byRule = { biginContactId: 0, phoneKey: 0 };
  const bySource = { web: 0, meta: 0, unknown: 0 };
  let dangling = 0;

  for (const task of linkedTasks) {
    const source = task.leadSource === 'meta' ? 'meta' : task.leadSource === 'web' ? 'web' : 'unknown';
    bySource[source] += 1;

    const lead = await loadLead(task.linkedLeadId, source);

    if (!lead) {
      // The Task points at a lead that no longer exists — a deleted lead, or a
      // half-written link. Surfaced rather than silently counted as a match.
      dangling += 1;
      continue;
    }

    const contactId = task.body && task.body.Who_Id && task.body.Who_Id.id;
    const matchedByIdentity =
      source === 'web' && lead.biginContactId && String(lead.biginContactId) === String(contactId);
    byRule[matchedByIdentity ? 'biginContactId' : 'phoneKey'] += 1;
  }

  const webLinked = await WebLead.countDocuments({ linkedTaskId: { $ne: null } });
  const tasksWithSource = await Task.countDocuments({ leadSource: { $ne: null } });

  heading('LEAD <-> CONTACT LINKS');
  line('leads linked to a contact', `${linkedTasks.length}/${leadTotal}`, pct(linkedTasks.length, leadTotal));
  line('  by biginContactId', byRule.biginContactId, 'identity — cannot be wrong');
  line('  by phoneKey', byRule.phoneKey, 'inference — last 10 digits');
  line('  dangling (lead missing)', dangling, dangling ? 'INVESTIGATE' : '');
  line('web leads linked (lead side)', `${webLinked}/${webTotal}`, pct(webLinked, webTotal));
  line('web leads unlinked', webTotal - webLinked);
  line('Meta leads unlinked', metaTotal - bySource.meta);

  heading('CONTACTS CARRYING A SOURCE');
  line('Tasks with a leadSource', `${tasksWithSource}/${taskTotal}`, pct(tasksWithSource, taskTotal));
  line('  leadSource = web', bySource.web);
  line('  leadSource = meta', bySource.meta);
  line('  linked but no source', bySource.unknown, bySource.unknown ? 'INVESTIGATE' : '');

  // ---- 4. The end-to-end number ------------------------------------------
  // What the Acquisition panel actually needs: a contact that reaches BOTH a lead
  // and a campaign. Either half alone renders an empty panel.
  const resolvedIds = await WebLead.find(
    { resolvedCampaignId: { $ne: null } },
    { _id: 1 }
  ).lean();
  const resolvedSet = new Set(resolvedIds.map((l) => String(l._id)));
  const metaWithCampaignIds = new Set(
    (await MetaLead.find({ campaignId: { $ne: null } }, { _id: 1 }).lean()).map((l) => String(l._id))
  );
  const endToEnd = linkedTasks.filter((t) => {
    const id = String(t.linkedLeadId);
    return t.leadSource === 'meta' ? metaWithCampaignIds.has(id) : resolvedSet.has(id);
  }).length;

  heading('END TO END — contacts with a lead AND a campaign');
  line('fully attributed contacts', `${endToEnd}/${taskTotal}`, pct(endToEnd, taskTotal));
  line('  of the linked ones', `${endToEnd}/${linkedTasks.length}`, pct(endToEnd, linkedTasks.length));

  // ---- 5. The actionable list --------------------------------------------
  const unresolvedUtms = await WebLead.aggregate([
    {
      $match: {
        resolvedCampaignId: null,
        resolvedBy: { $ne: 'unmapped' },
        utmCampaign: { $nin: [null, ''] },
      },
    },
    { $group: { _id: '$utmCampaign', n: { $sum: 1 } } },
    { $sort: { n: -1, _id: 1 } },
  ]);

  heading('UNRESOLVED utm_campaign VALUES (not yet triaged)');
  if (!unresolvedUtms.length) {
    console.log('  (none — every tagged lead either matched a campaign or was triaged)');
  } else {
    console.log('  Ad URLs tagged with something that is not a campaign name. Fix at');
    console.log('  source in Meta, rename the campaign to match, or — for the history a');
    console.log('  fix cannot reach — map it: POST /api/ads/campaign-aliases.\n');
    unresolvedUtms.forEach((u) => console.log(`  ${String(u.n).padStart(6)}  ${JSON.stringify(u._id)}`));
  }

  // Triaged and closed. Listed so "why is this lead not attributed" always has an
  // answer on the page, rather than the operator re-investigating a string a
  // colleague already ruled on months ago.
  const unmappedUtms = await WebLead.aggregate([
    { $match: { resolvedBy: 'unmapped' } },
    { $group: { _id: '$utmCampaign', n: { $sum: 1 } } },
    { $sort: { n: -1, _id: 1 } },
  ]);

  if (unmappedUtms.length) {
    heading('DELIBERATELY UNMAPPED utm_campaign VALUES');
    console.log('  An admin checked these and recorded that no Meta campaign exists for');
    console.log('  them (Google Ads traffic, test data). Not actionable — not a gap.\n');
    unmappedUtms.forEach((u) => console.log(`  ${String(u.n).padStart(6)}  ${JSON.stringify(u._id)}`));
  }

  // The aliases themselves, so the report says on its face which attributions
  // rest on an operator's assertion rather than on Meta's own data.
  const aliases = await CampaignAlias.find({}).sort({ campaignId: 1, _id: 1 }).lean();
  if (aliases.length) {
    const names = new Map(
      (await MetaCampaign.find({}, { name: 1 }).lean()).map((c) => [String(c._id), c.name])
    );
    heading('CAMPAIGN ALIASES IN FORCE');
    aliases.forEach((a) => {
      const target = a.campaignId
        ? `${a.campaignId}  ${names.get(String(a.campaignId)) || '(NOT IN MIRROR)'}`
        : '(deliberately unmapped)';
      console.log(`  ${JSON.stringify(a.utmCampaign)}\n      -> ${target}`);
    });
  }

  console.log('\n' + '='.repeat(72));
  console.log('  PHASE GATE: is the match rate above good enough to build UI on?');
  console.log('  If not, tune modules/ads/services/campaignResolver.js and re-run');
  console.log('  steps 2-4 — the backfills are idempotent.');
  console.log('='.repeat(72) + '\n');

  await mongoose.connection.close();
}

run().catch((err) => {
  console.error('Report failed:', err.message);
  process.exit(1);
});
