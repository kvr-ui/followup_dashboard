const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCampaign } = require('../campaigns/CampaignService');
const { normalizeAdset } = require('../adsets/AdsetService');
const { normalizeAd } = require('../ads/AdService');
const { normalizeCreative } = require('../creatives/CreativeService');
const { normalizeInsight } = require('../insights/InsightService');
const { normalizeLead, normalizeLeadForm } = require('../leads/LeadService');

/** Assert every key in `expected` matches on `actual` (like toMatchObject). */
function assertMatches(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(actual[key], value, `field ${key}`);
  }
}

describe('normalizeCampaign', () => {
  it('parses budgets to numbers and maps fields', () => {
    const c = normalizeCampaign({
      id: '1',
      name: 'CA Foundation',
      objective: 'OUTCOME_LEADS',
      status: 'ACTIVE',
      daily_budget: '5000',
      created_time: '2026-07-01T00:00:00+0000',
    });
    assertMatches(c, {
      id: '1',
      name: 'CA Foundation',
      objective: 'OUTCOME_LEADS',
      status: 'ACTIVE',
      dailyBudget: 5000,
      lifetimeBudget: null,
    });
  });

  it('defaults missing name/status and nulls absent fields', () => {
    const c = normalizeCampaign({ id: '1' });
    assert.equal(c.name, '');
    assert.equal(c.status, 'UNKNOWN');
    assert.equal(c.objective, null);
    assert.equal(c.dailyBudget, null);
  });
});

describe('normalizeAdset', () => {
  it('maps snake_case to camelCase and campaign id', () => {
    const a = normalizeAdset({
      id: '2',
      name: 'Set A',
      campaign_id: '1',
      status: 'PAUSED',
      optimization_goal: 'LEAD_GENERATION',
      billing_event: 'IMPRESSIONS',
      lifetime_budget: '20000',
    });
    assertMatches(a, {
      id: '2',
      campaignId: '1',
      status: 'PAUSED',
      optimizationGoal: 'LEAD_GENERATION',
      billingEvent: 'IMPRESSIONS',
      lifetimeBudget: 20000,
    });
  });
});

describe('normalizeAd', () => {
  it('extracts the creative id from the nested creative object', () => {
    const ad = normalizeAd({
      id: '3',
      name: 'Ad 1',
      adset_id: '2',
      campaign_id: '1',
      creative: { id: 'cr1' },
    });
    assert.equal(ad.creativeId, 'cr1');
    assert.equal(ad.adsetId, '2');
  });

  it('nulls the creative id when absent', () => {
    assert.equal(normalizeAd({ id: '3' }).creativeId, null);
  });
});

describe('normalizeCreative', () => {
  it('derives link url and CTA from object_story_spec', () => {
    const cr = normalizeCreative({
      id: 'cr1',
      name: 'Creative',
      image_url: 'https://img',
      object_story_spec: {
        link_data: { link: 'https://landing', call_to_action: { type: 'SIGN_UP' } },
      },
    });
    assert.equal(cr.linkUrl, 'https://landing');
    assert.equal(cr.callToActionType, 'SIGN_UP');
    assert.equal(cr.imageUrl, 'https://img');
  });

  it('prefers a top-level call_to_action_type over the spec', () => {
    const cr = normalizeCreative({
      id: 'cr1',
      call_to_action_type: 'LEARN_MORE',
      object_story_spec: { link_data: { call_to_action: { type: 'SIGN_UP' } } },
    });
    assert.equal(cr.callToActionType, 'LEARN_MORE');
  });
});

describe('normalizeInsight', () => {
  it('coerces metrics to numbers, maps actions, and reads roas', () => {
    const i = normalizeInsight({
      date_start: '2026-07-01',
      date_stop: '2026-07-03',
      campaign_id: '1',
      spend: '1234.56',
      impressions: '10000',
      clicks: '250',
      ctr: '2.5',
      actions: [
        { action_type: 'lead', value: '12' },
        { action_type: 'link_click', value: '250' },
      ],
      purchase_roas: [{ action_type: 'omni_purchase', value: '3.2' }],
    });
    assert.equal(i.spend, 1234.56);
    assert.equal(i.impressions, 10000);
    assert.deepEqual(i.actions, [
      { type: 'lead', value: 12 },
      { type: 'link_click', value: 250 },
    ]);
    assert.equal(i.roas, 3.2);
  });

  it('defaults absent metrics to 0 and roas to null', () => {
    const i = normalizeInsight({});
    assert.equal(i.spend, 0);
    assert.equal(i.clicks, 0);
    assert.deepEqual(i.actions, []);
    assert.equal(i.roas, null);
  });
});

describe('normalizeLead / normalizeLeadForm', () => {
  it('maps field_data entries', () => {
    const lead = normalizeLead({
      id: 'l1',
      created_time: '2026-07-02T10:00:00+0000',
      ad_id: '3',
      field_data: [
        { name: 'full_name', values: ['Asha'] },
        { name: 'email', values: ['asha@example.com'] },
      ],
    });
    assert.equal(lead.adId, '3');
    assert.deepEqual(lead.fieldData, [
      { name: 'full_name', values: ['Asha'] },
      { name: 'email', values: ['asha@example.com'] },
    ]);
  });

  it('parses leads_count on lead forms', () => {
    const form = normalizeLeadForm({ id: 'f1', name: 'CA Form', status: 'ACTIVE', leads_count: '42' });
    assert.equal(form.leadsCount, 42);
    assert.equal(form.status, 'ACTIVE');
  });
});
