// Where do the SALES come from? READ-ONLY — it opens no write, anywhere.
//
//   node backend/scripts/leadSourceReport.js [cache.json]
//
// Answers "which lead source closed the deal", straight from Bigin, and then —
// for the leads Meta produced — carries the attribution the rest of the way down
// to the campaign that paid for them.
//
// THE CHAIN
// ---------
//   Bigin Deal (Stage = 'Closed with Sale')
//     -> Contact_Name          the deal's contact
//        -> Lead_Source1               free-text channel the team typed
//        -> leadchain2__Social_Lead_ID Meta's own lead id, stamped by LeadChain
//           -> MetaLead.campaignId     our Meta mirror
//              -> MetaCampaign.name + MetaInsight.spend
//
// Every link above is an ID, not an inference — no phone matching, no fuzzy
// names. That is why this report is worth trusting where it has data, and why
// the coverage lines at the end matter as much as the totals: a source is only
// as good as the share of deals that carry one.
//
// TWO FIELDS, TWO WEAKNESSES, BOTH REPORTED
// -----------------------------------------
//   * `Lead_Source1` is a TEXT field, not a picklist, so the same channel arrives
//     spelled several ways ("Whatsapp" / "WhatsApp DMs" / "Whatsapp Dms"). The
//     canonical() map below merges them for the headline table and the raw values
//     are printed underneath, so the merge is auditable rather than hidden.
//   * `leadchain2__Social_Lead_ID` is text too, and the team sometimes types notes
//     into it ("Repeater candidate"). Only a 6+ digit numeric value is treated as
//     a real Meta lead id.
//
// `.env` is resolved from THIS file, not from the shell's cwd — same reason as
// attributionReport.js: a bare dotenv.config() would silently read a dev database.
//
// Pass a cache path to keep the Bigin pull on disk (contacts + deals, ~7k + ~6.5k
// records); re-runs then cost nothing at Zoho. Delete the files to refresh.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const mongoose = require('mongoose');
const { apiGet, isConfigured } = require('../services/zoho');
const MetaCampaign = require('../modules/ads/models/MetaCampaign');
const MetaInsight = require('../modules/ads/models/MetaInsight');
const MetaLead = require('../modules/ads/models/MetaLead');

const CACHE = process.argv[2];

// Bigin's REST module name for the pipeline module is `Deals`, even though its
// metadata/COQL name is `Pipelines`. Using the latter here 404s.
const DEALS_MODULE = 'Deals';

const WON = new Set(['Closed with Sale', 'Closed Won']);
const LOST = new Set(['Closed without Sale', 'Closed Lost']);

const META_LEAD_ID = /^\d{6,}$/;

async function fetchAll(module, fields) {
  const out = [];
  let pageToken = null;
  let page = 1;
  // Bounded so a paging bug cannot spin forever against Zoho's rate limit.
  for (let i = 0; i < 100; i += 1) {
    const qs = pageToken ? `page_token=${encodeURIComponent(pageToken)}` : `page=${page}`;
    const r = await apiGet(`/${module}?fields=${fields}&per_page=200&${qs}`);
    if (!r.ok) throw new Error(r.error || `${module} fetch failed`);
    const data = (r.json && r.json.data) || [];
    out.push(...data);
    const info = (r.json && r.json.info) || {};
    process.stderr.write(`  ${module} page ${page}: ${data.length} (total ${out.length})\n`);
    if (!info.more_records) break;
    if (info.next_page_token) {
      pageToken = info.next_page_token;
    } else {
      page += 1;
      pageToken = null;
    }
  }
  return out;
}

async function cached(path, load) {
  if (path && fs.existsSync(path)) {
    const rows = JSON.parse(fs.readFileSync(path, 'utf8'));
    process.stderr.write(`  loaded ${rows.length} from ${path}\n`);
    return rows;
  }
  const rows = await load();
  if (path) fs.writeFileSync(path, JSON.stringify(rows));
  return rows;
}

/**
 * Merge the spellings of one channel. Deliberately conservative: anything that
 * doesn't match a known pattern is passed through verbatim rather than swept into
 * an "Other" bucket, so a new channel shows up as itself the first time it sells.
 */
function canonical(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return '(no source set)';
  if (/^(ig|fb|instagram ads|facebook ads|meta ads|fb ads|ig ads)$/.test(s)) return 'Meta Ads';
  if (/whatsapp ads/.test(s)) return 'WhatsApp Ads (Meta)';
  if (/whatsapp|wa dm/.test(s)) return 'WhatsApp (organic/DM)';
  if (/instagram dm|ig dm/.test(s)) return 'Instagram DM (organic)';
  if (/student reg/.test(s)) return 'Student Registration';
  if (/refer|reffer/.test(s)) return 'Referral';
  if (/direct call/.test(s)) return 'Direct Call';
  if (/sayl/.test(s)) return 'SAYL';
  if (/upsell/.test(s)) return 'Upsell';
  if (/^kit/.test(s)) return 'Kit form';
  if (/manual/.test(s)) return 'Manual';
  return raw;
}

const money = (n) => Math.round(n).toLocaleString('en-IN');
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a');

function heading(title) {
  console.log(`\n=== ${title} ===`);
}

async function run() {
  if (!isConfigured()) {
    console.error('Zoho is not configured — set ZOHO_CLIENT_ID / SECRET / REFRESH_TOKEN.');
    process.exit(1);
  }
  // READ-ONLY means read-only: index builds are writes.
  mongoose.set('autoIndex', false);

  const dealCache = CACHE ? CACHE.replace(/\.json$/, '') + '-deals.json' : null;

  process.stderr.write('pulling Bigin...\n');
  const contacts = await cached(CACHE, () =>
    fetchAll('Contacts', 'id,Lead_Source1,leadchain2__Social_Lead_ID,Created_Time')
  );
  const deals = await cached(dealCache, () =>
    fetchAll(DEALS_MODULE, 'id,Deal_Name,Stage,Amount,Closing_Date,Created_Time,Sub_Pipeline,Contact_Name')
  );

  const contactById = new Map(contacts.map((c) => [String(c.id), c]));

  console.log('\n' + '='.repeat(94));
  console.log('  LEAD SOURCE -> SALE  (read-only, live from Bigin)');
  console.log(`  generated ${new Date().toISOString()}`);
  console.log(`  ${deals.length} deals, ${contacts.length} contacts`);
  console.log('='.repeat(94));

  // ---- 1. The headline: closes by source ---------------------------------
  const agg = new Map();
  let noContact = 0;
  let wonNoContact = 0;

  for (const d of deals) {
    const cid = d.Contact_Name && d.Contact_Name.id;
    const contact = cid ? contactById.get(String(cid)) : null;
    const won = WON.has(d.Stage);
    if (!cid) {
      noContact += 1;
      if (won) wonNoContact += 1;
    }

    const key = canonical(contact ? contact.Lead_Source1 : null);
    const row =
      agg.get(key) ||
      { src: key, deals: 0, won: 0, lost: 0, open: 0, revenue: 0, metaId: 0, wonMetaId: 0 };

    row.deals += 1;
    if (won) {
      row.won += 1;
      row.revenue += d.Amount || 0;
    } else if (LOST.has(d.Stage)) row.lost += 1;
    else row.open += 1;

    const socialId = contact && contact.leadchain2__Social_Lead_ID;
    if (socialId && META_LEAD_ID.test(String(socialId))) {
      row.metaId += 1;
      if (won) row.wonMetaId += 1;
    }
    agg.set(key, row);
  }

  const rows = [...agg.values()].sort((a, b) => b.won - a.won || b.deals - a.deals);
  const tot = rows.reduce(
    (a, r) => ({
      deals: a.deals + r.deals,
      won: a.won + r.won,
      lost: a.lost + r.lost,
      open: a.open + r.open,
      revenue: a.revenue + r.revenue,
    }),
    { deals: 0, won: 0, lost: 0, open: 0, revenue: 0 }
  );

  const head =
    'source'.padEnd(24) +
    'deals'.padStart(7) +
    'won'.padStart(6) +
    'lost'.padStart(7) +
    'open'.padStart(6) +
    'win%'.padStart(7) +
    'revenue'.padStart(13) +
    'avg sale'.padStart(10) +
    'rev share'.padStart(10) +
    'meta id'.padStart(9);

  heading('CLOSED WITH SALE, BY LEAD SOURCE');
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const r of rows) {
    console.log(
      String(r.src).slice(0, 23).padEnd(24) +
        String(r.deals).padStart(7) +
        String(r.won).padStart(6) +
        String(r.lost).padStart(7) +
        String(r.open).padStart(6) +
        pct(r.won, r.deals).padStart(7) +
        money(r.revenue).padStart(13) +
        (r.won ? money(r.revenue / r.won) : '-').padStart(10) +
        pct(r.revenue, tot.revenue).padStart(10) +
        `${r.wonMetaId}/${r.won}`.padStart(9)
    );
  }
  console.log('-'.repeat(head.length));
  console.log(
    'TOTAL'.padEnd(24) +
      String(tot.deals).padStart(7) +
      String(tot.won).padStart(6) +
      String(tot.lost).padStart(7) +
      String(tot.open).padStart(6) +
      pct(tot.won, tot.deals).padStart(7) +
      money(tot.revenue).padStart(13)
  );
  console.log('\n  meta id = won deals whose contact carries a real Meta lead id.');

  // The win% column is only honest against a denominator that could have been
  // attributed at all. A deal with no contact attached in Bigin has no source and
  // never will, so it drags every rate down without being a marketing fact.
  heading('COVERAGE — can a deal be attributed at all?');
  console.log(`  deals with no contact linked in Bigin   ${noContact}/${deals.length}  ${pct(noContact, deals.length)}`);
  console.log(`  WON deals with no contact linked        ${wonNoContact}/${tot.won}  ${pct(wonNoContact, tot.won)}`);
  const blank = agg.get('(no source set)');
  if (blank) {
    console.log(`  deals whose contact has a blank source  ${blank.deals - noContact}`);
  }

  // ---- 2. The raw field, unmerged ----------------------------------------
  const raw = new Map();
  for (const c of contacts) {
    const k = c.Lead_Source1 == null || c.Lead_Source1 === '' ? '(blank)' : c.Lead_Source1;
    raw.set(k, (raw.get(k) || 0) + 1);
  }
  heading('RAW Lead_Source1 VALUES ON CONTACTS (the merge above, unmerged)');
  console.log('  A picklist would end this list. It is a text field, so it grows.\n');
  [...raw.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, n]) => console.log(`  ${String(n).padStart(6)}  ${JSON.stringify(k)}`));

  // ---- 3. Down to the campaign -------------------------------------------
  // Bigin's LeadChain extension stamps Meta's lead id on the contact; our Meta
  // mirror knows which campaign produced that lead. Joining them is the only
  // campaign-level revenue attribution available — and it is exact, not inferred.
  const wonDeals = deals.filter((d) => WON.has(d.Stage));
  const wonWithMeta = wonDeals
    .map((d) => {
      const cid = d.Contact_Name && d.Contact_Name.id;
      const contact = cid ? contactById.get(String(cid)) : null;
      const socialId = contact && contact.leadchain2__Social_Lead_ID;
      return socialId && META_LEAD_ID.test(String(socialId))
        ? { deal: d, leadId: String(socialId) }
        : null;
    })
    .filter(Boolean);

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });

  const mirrored = await MetaLead.countDocuments({});
  const leads = await MetaLead.find(
    { _id: { $in: wonWithMeta.map((w) => w.leadId) } },
    { campaignId: 1, adId: 1, formId: 1 }
  ).lean();
  const leadById = new Map(leads.map((l) => [String(l._id), l]));

  heading('META: FROM THE SALE BACK TO THE CAMPAIGN');
  console.log(`  won deals                               ${wonDeals.length}`);
  console.log(`  ...carrying a Meta lead id              ${wonWithMeta.length}  ${pct(wonWithMeta.length, wonDeals.length)}`);
  console.log(`  ...whose lead is in our Meta mirror     ${leads.length}  ${pct(leads.length, wonWithMeta.length)}`);
  console.log(`  MetaLead documents mirrored in total    ${mirrored}`);

  if (!mirrored) {
    console.log(
      '\n  THE CHAIN IS BROKEN HERE. The Meta lead mirror is EMPTY, so every Meta\n' +
        '  lead id above resolves to nothing and no sale can be traced to a campaign.\n' +
        '  Cause: the lead stage of the ad sync has no forms to read. Set either\n' +
        '  META_LEAD_FORM_IDS or META_PAGE_ID and re-run the sync — campaigns, ads\n' +
        '  and spend are already mirrored, leads are the one missing link.'
    );
  }

  if (leads.length) {
    const campaignIds = [...new Set(leads.map((l) => l.campaignId).filter(Boolean))];
    const names = new Map(
      (await MetaCampaign.find({ _id: { $in: campaignIds } }, { name: 1 }).lean()).map((c) => [
        String(c._id),
        c.name,
      ])
    );

    const byCampaign = new Map();
    for (const { deal, leadId } of wonWithMeta) {
      const lead = leadById.get(leadId);
      const cid = lead && lead.campaignId ? String(lead.campaignId) : null;
      const key = cid || '(lead not mirrored / no campaign)';
      const e = byCampaign.get(key) || { won: 0, revenue: 0 };
      e.won += 1;
      e.revenue += deal.Amount || 0;
      byCampaign.set(key, e);
    }

    console.log('\n  campaign'.padEnd(56) + 'won'.padStart(6) + 'revenue'.padStart(13) + 'spend'.padStart(12) + 'ROAS'.padStart(8) + 'CAC'.padStart(10));
    for (const [cid, e] of [...byCampaign.entries()].sort((a, b) => b[1].revenue - a[1].revenue)) {
      const spendRows = await MetaInsight.aggregate([
        { $match: { level: 'campaign', entityId: cid } },
        { $group: { _id: null, spend: { $sum: '$spend' } } },
      ]);
      const spend = spendRows.length ? spendRows[0].spend : 0;
      console.log(
        '  ' +
          String(names.get(cid) || cid).slice(0, 52).padEnd(54) +
          String(e.won).padStart(6) +
          money(e.revenue).padStart(13) +
          (spend ? money(spend) : '-').padStart(12) +
          (spend ? (e.revenue / spend).toFixed(2) : '-').padStart(8) +
          (e.won && spend ? money(spend / e.won) : '-').padStart(10)
      );
    }
    console.log(
      '\n  Spend is the campaign lifetime in the insight mirror, revenue is only the\n' +
        '  deals closed from ITS leads — the two cover different windows. Read the\n' +
        '  ROAS as a ranking between campaigns, not as an audited return.'
    );
  }

  console.log('\n' + '='.repeat(94) + '\n');
  await mongoose.connection.close();
}

run().catch((err) => {
  console.error('Report failed:', err.message);
  process.exit(1);
});
