const { describe, it, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { MetaAdsConnector } = require('..');

/** Stub global fetch with an empty edge response, recording every URL requested. */
function captureUrls() {
  const urls = [];
  mock.method(globalThis, 'fetch', async (url) => {
    urls.push(url);
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  });
  return urls;
}

describe('MetaAdsConnector', () => {
  afterEach(() => mock.restoreAll());

  it('prepends act_ to a bare ad account id and hits the campaigns edge', async () => {
    const urls = captureUrls();
    const meta = new MetaAdsConnector({ accessToken: 'T', adAccountId: '12345' });
    await meta.getCampaigns();
    assert.ok(urls[0].includes('/act_12345/campaigns'));
  });

  it('keeps an existing act_ prefix', async () => {
    const urls = captureUrls();
    const meta = new MetaAdsConnector({ accessToken: 'T', adAccountId: 'act_9' });
    await meta.getCampaigns();
    assert.ok(urls[0].includes('/act_9/campaigns'));
    assert.ok(!urls[0].includes('act_act_9'));
  });

  it('passes a JSON time_range and default level to the insights edge', async () => {
    const urls = captureUrls();
    const meta = new MetaAdsConnector({ accessToken: 'T', adAccountId: 'act_9' });
    await meta.getInsights({ from: '2026-07-01', to: '2026-07-03' });

    const url = new URL(urls[0]);
    assert.ok(url.pathname.includes('/act_9/insights'));
    assert.deepEqual(JSON.parse(url.searchParams.get('time_range')), {
      since: '2026-07-01',
      until: '2026-07-03',
    });
    assert.equal(url.searchParams.get('level'), 'campaign');
  });

  it('validates required constructor config', () => {
    assert.throws(() => new MetaAdsConnector({ accessToken: '', adAccountId: '1' }), /accessToken/);
    assert.throws(() => new MetaAdsConnector({ accessToken: 'T', adAccountId: '' }), /adAccountId/);
  });

  it('requires a formId for getLeads', async () => {
    const meta = new MetaAdsConnector({ accessToken: 'T', adAccountId: '1' });
    await assert.rejects(meta.getLeads(''), /formId/);
  });
});
