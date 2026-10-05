const { toNumber } = require('../utils/normalize');

const LEAD_FIELDS = ['id', 'created_time', 'ad_id', 'form_id', 'campaign_id', 'field_data'];

const LEAD_FORM_FIELDS = ['id', 'name', 'status', 'leads_count'];

function normalizeFieldData(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => ({
    name: entry.name ?? '',
    values: Array.isArray(entry.values) ? entry.values : [],
  }));
}

/** @returns {import('../types').Lead} */
function normalizeLead(raw) {
  return {
    id: raw.id,
    createdTime: raw.created_time ?? null,
    adId: raw.ad_id ?? null,
    formId: raw.form_id ?? null,
    campaignId: raw.campaign_id ?? null,
    fieldData: normalizeFieldData(raw.field_data),
  };
}

/** @returns {import('../types').LeadForm} */
function normalizeLeadForm(raw) {
  return {
    id: raw.id,
    name: raw.name ?? '',
    status: raw.status ?? null,
    leadsCount: toNumber(raw.leads_count),
  };
}

class LeadService {
  /** @param {import('../client/MetaClient').MetaClient} client */
  constructor(client) {
    this.client = client;
  }

  /**
   * Fetch all leads submitted against a specific lead form.
   * @param {string} formId
   */
  async getLeads(formId) {
    if (!formId) throw new Error('LeadService.getLeads requires a formId');
    const raw = await this.client.getEdge(`/${formId}/leads`, {
      fields: LEAD_FIELDS.join(','),
      limit: 200,
    });
    return raw.map(normalizeLead);
  }

  /**
   * Fetch the lead generation forms belonging to a Facebook Page.
   * @param {string} pageId
   */
  async getForms(pageId) {
    if (!pageId) throw new Error('LeadService.getForms requires a pageId');
    const raw = await this.client.getEdge(`/${pageId}/leadgen_forms`, {
      fields: LEAD_FORM_FIELDS.join(','),
      limit: 100,
    });
    return raw.map(normalizeLeadForm);
  }
}

module.exports = { LeadService, normalizeLead, normalizeLeadForm };
