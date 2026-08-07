const mongoose = require('mongoose');
const { applyJsonTransform, model } = require('./_shared');

// An operator's assertion that a `utm_campaign` string means a particular Meta
// campaign — the fourth and weakest tier of campaignResolver.
//
// WHY THIS IS DATA AND NOT A CONSTANT
// -----------------------------------
// Every Meta campaign name here carries a DDMM suffix ("Focas x Website Leads
// Campaign 2904") that the hand-written UTM tags never reproduced, so no amount
// of string normalisation closes the gap — see plans/crm-integration and the
// attribution report that resolved 0 of 80 tagged leads. The tags will drift
// again the next time somebody builds an ad by hand, and a code deploy is the
// wrong ceremony for "these two strings are the same campaign". So the mapping is
// a collection an admin edits through /api/ads/campaign-aliases.
//
// THE KEY IS THE NORMALIZED UTM, NOT THE RAW ONE
// ----------------------------------------------
// `_id` is `normalizeName(utm_campaign)` — lowercased, non-alphanumerics
// stripped. Keyed on the raw string, an alias entered for "Website Lead Campaign
// x Focas" would stop matching the day somebody re-tagged an ad as "website-lead
// campaign x focas", and the operator would have to notice and add a second row
// for what is plainly the same thing. Keyed on the normalized form, one entry
// survives incidental case and punctuation changes. The raw string the operator
// typed is kept alongside, for display only.
//
// NULL `campaignId` IS A DECISION, NOT A GAP
// -----------------------------------------
// A row with `campaignId: null` is the operator saying "I looked, and this UTM
// has no Meta campaign" — Google Ads traffic, or test data. That is why the row
// exists at all, and it is what takes those strings off the actionable unresolved
// list. The distinction is the row's existence:
//
//   no row            -> not yet triaged   (actionable: somebody should look)
//   row, campaignId   -> mapped            (resolves, method 'alias')
//   row, null         -> deliberately unmapped (resolves to nothing, method 'unmapped')
const campaignAliasSchema = new mongoose.Schema(
  {
    // normalizeName(utmCampaign). Never empty — a UTM of pure punctuation has no
    // key and cannot be aliased.
    _id: { type: String },

    // Exactly what the operator typed, kept verbatim so the list reads like the
    // data does. Never used for matching.
    utmCampaign: { type: String, required: true },

    // MetaCampaign._id (Meta's own string id), or null for "deliberately
    // unmapped" — see the header. Not a ref: every other cross-reference in this
    // module stores the bare Meta id too.
    campaignId: { type: String, default: null, index: true },

    // Why, in the operator's words. The unmapped rows are the ones that need it
    // ("Google Ads traffic, no Meta campaign exists") — six months from now
    // nobody remembers whether a null was a decision or an abandoned edit.
    note: { type: String, default: null },

    // Who asserted this, and — via `timestamps` — when. An alias is an opinion,
    // and an opinion that cannot be attributed cannot be questioned. `id` is null
    // for rows written by the seed script, which names itself in `name`.
    createdBy: {
      id: { type: String, default: null },
      name: { type: String, default: null },
    },
    updatedBy: {
      id: { type: String, default: null },
      name: { type: String, default: null },
    },
  },
  { timestamps: true }
);

applyJsonTransform(campaignAliasSchema);

module.exports = model('CampaignAlias', campaignAliasSchema);
