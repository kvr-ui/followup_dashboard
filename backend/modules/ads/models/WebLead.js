const mongoose = require('mongoose');
const { applyJsonTransform, model } = require('./_shared');

// A lead captured on a Focas landing page, carrying the UTM parameters the ad
// click brought with it. Locally created, so an ordinary generated ObjectId.
const webLeadSchema = new mongoose.Schema({
  name: String,
  firstName: String,
  lastName: String,
  email: String,
  phone: String,

  // Counseling-form / qualification details.
  caStatus: String,
  attempt: String,
  language: String,
  city: String,
  state: String,

  // Attribution captured from the landing-page URL.
  utmSource: String,
  utmMedium: String,
  utmCampaign: String,
  utmContent: String,
  utmTerm: String,
  landingUrl: String,
  referrer: String,

  // Link back to the matching Bigin contact + which form produced this lead.
  biginContactId: String,
  source: String, // e.g. "counseling-form"

  createdAt: { type: Date, default: Date.now },

  // ---- Resolution fields ---------------------------------------------------
  // Declared here, populated by the resolver and the backfill. All null until
  // then; nothing in this file writes them.

  // Last 10 digits of `phone` — the indexed key that matches this lead to a Task
  // and to a MetaLead by equality instead of a regex suffix scan.
  phoneKey: { type: String, default: null, index: true },

  // The MetaCampaign `_id` (Meta's own string id) this lead's UTM resolved to,
  // or null when no campaign could be matched.
  resolvedCampaignId: { type: String, default: null, index: true },

  // HOW the campaign above was resolved, so a suspicious attribution can be
  // traced: 'exact' (utmCampaign matched a campaign name verbatim),
  // 'normalized' (matched after case/punctuation normalisation), 'id' (the UTM
  // carried the campaign id outright), 'alias' (no Meta data matched; an admin
  // asserted the mapping in the CampaignAlias table), or null (unresolved).
  //
  // 'unmapped' is the odd one: `resolvedCampaignId` is null, as it is for an
  // unresolved lead, but an admin has TRIAGED this UTM and recorded that no Meta
  // campaign exists for it (Google Ads traffic, test data). Stored so the
  // attribution report can stop listing it as something to go and fix.
  resolvedBy: {
    type: String,
    enum: ['exact', 'normalized', 'id', 'alias', 'unmapped', null],
    default: null,
  },

  // The Task this lead was matched to, or null.
  linkedTaskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    default: null,
    index: true,
  },
});

webLeadSchema.index({ utmSource: 1 });
webLeadSchema.index({ utmCampaign: 1 });
webLeadSchema.index({ source: 1 });
webLeadSchema.index({ createdAt: 1 });
applyJsonTransform(webLeadSchema);

module.exports = model('WebLead', webLeadSchema);
