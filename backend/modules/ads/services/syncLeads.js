// Pull instant-form leads from Meta into MetaLead.
//
// Leads are the odd one out: Meta exposes them per LEAD FORM, not per ad account,
// so there is nothing to enumerate from the account itself. The form ids come from
// the environment:
//
//   META_LEAD_FORM_IDS  comma-separated form ids — the explicit, cheapest option
//   META_PAGE_ID        a Facebook Page id; every lead form on it is discovered
//
// Set either one and a full sync picks leads up. Set neither and the lead stage is
// skipped with a log line rather than failing — the campaign/spend half of the
// sync is useful on its own, and the retired CRM ran leads separately for exactly
// that reason.
//
// `phoneKey` is deliberately NOT written here. It is derived from fieldData by the
// attribution task, which owns that normalisation for both lead sources.
const MetaCampaign = require('../models/MetaCampaign');
const MetaLead = require('../models/MetaLead');
const meta = require('./metaClient');
const { keepIfKnown, loadKnownIds } = require('./syncHelpers');

/** Fetch every lead for one lead form and upsert it. Returns the count. */
async function syncLeads(formId) {
  const leads = await meta.getLeads(formId);

  const knownCampaigns = await loadKnownIds(MetaCampaign);

  if (leads.length) {
    await MetaLead.bulkWrite(
      leads.map((lead) => ({
        updateOne: {
          filter: { _id: lead.id },
          update: {
            $set: {
              createdTime: lead.createdTime,
              // adId is left as Meta sent it: a lead can outlive the ad that
              // produced it, and losing the id would lose the attribution.
              adId: lead.adId,
              formId: lead.formId,
              campaignId: keepIfKnown(lead.campaignId, knownCampaigns),
              fieldData: lead.fieldData,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );
  }

  return leads.length;
}

/** The lead forms to sync, from explicit ids or by discovery on a Page. */
async function resolveFormIds() {
  const explicit = (process.env.META_LEAD_FORM_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length) return explicit;

  const pageId = (process.env.META_PAGE_ID || '').trim();
  if (!pageId) return [];

  const forms = await meta.getLeadForms(pageId);
  return forms.map((f) => f.id);
}

/**
 * Sync every configured lead form. Returns the total lead count across forms.
 * One bad form (deleted, or missing leads_retrieval permission) is logged and
 * skipped so the rest still land.
 */
async function syncAllLeads() {
  const formIds = await resolveFormIds();
  if (!formIds.length) {
    console.log('[ads sync] no lead forms configured (set META_LEAD_FORM_IDS or META_PAGE_ID)');
    return 0;
  }

  let total = 0;
  for (const formId of formIds) {
    try {
      total += await syncLeads(formId);
    } catch (err) {
      console.warn(`[ads sync] lead form ${formId} failed:`, err.message);
    }
  }
  return total;
}

module.exports = { syncLeads, syncAllLeads, resolveFormIds };
