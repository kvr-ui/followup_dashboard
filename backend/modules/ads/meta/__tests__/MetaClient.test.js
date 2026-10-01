const { describe, it, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { MetaClient } = require('../client/MetaClient');
const { MetaAuthError, MetaTransientError } = require('../utils/Errors');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Replace global fetch with a mock returning each response in turn (last one repeats). */
function stubFetch(...responders) {
  let i = 0;
  const fn = mock.fn(async (url) => {
    const responder = responders[Math.min(i++, responders.length - 1)];
    return responder(url);
  });
  mock.method(globalThis, 'fetch', fn);
  return fn;
}

describe('MetaClient', () => {
  afterEach(() => mock.restoreAll());

  it('builds URLs with version, params, and access token; drops undefined params', () => {
    const client = new MetaClient({ accessToken: 'T', apiVersion: 'v24.0' });
    const url = new URL(
      client.buildUrl('/act_1/campaigns', { fields: 'id,name', limit: 5, skip: undefined }),
    );
    assert.equal(url.origin + url.pathname, 'https://graph.facebook.com/v24.0/act_1/campaigns');
    assert.equal(url.searchParams.get('fields'), 'id,name');
    assert.equal(url.searchParams.get('limit'), '5');
    assert.equal(url.searchParams.has('skip'), false);
    assert.equal(url.searchParams.get('access_token'), 'T');
  });

  it('get() returns the parsed node', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ id: '1', name: 'me' }));
    const client = new MetaClient({ accessToken: 'T' });
    assert.deepEqual(await client.get('/me'), { id: '1', name: 'me' });
    assert.equal(fetchMock.mock.callCount(), 1);
  });

  it('getEdge() auto-paginates across pages', async () => {
    const fetchMock = stubFetch(
      () =>
        jsonResponse({
          data: [{ id: '1' }],
          paging: { next: 'https://graph.facebook.com/v24.0/next' },
        }),
      () => jsonResponse({ data: [{ id: '2' }] }),
    );
    const client = new MetaClient({ accessToken: 'T' });
    const all = await client.getEdge('/act_1/campaigns');
    assert.deepEqual(
      all.map((x) => x.id),
      ['1', '2'],
    );
    assert.equal(fetchMock.mock.callCount(), 2);
  });

  it('retries on HTTP 429 then succeeds', async () => {
    const fetchMock = stubFetch(
      () => jsonResponse({ error: { code: 4, message: 'rate' } }, 429),
      () => jsonResponse({ id: '1' }),
    );
    const client = new MetaClient({ accessToken: 'T' });
    assert.deepEqual(await client.get('/me'), { id: '1' });
    assert.equal(fetchMock.mock.callCount(), 2);
  });

  it('does not retry auth errors (fails fast)', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ error: { code: 190, message: 'bad token' } }, 400),
    );
    const client = new MetaClient({ accessToken: 'T' });
    await assert.rejects(client.get('/me'), MetaAuthError);
    assert.equal(fetchMock.mock.callCount(), 1);
  });

  it('wraps network failures as retryable transient errors', async () => {
    const fetchMock = stubFetch(() => {
      throw new Error('ECONNRESET');
    });
    const client = new MetaClient({ accessToken: 'T', maxRetries: 1 });
    await assert.rejects(client.get('/me'), MetaTransientError);
    assert.equal(fetchMock.mock.callCount(), 2); // 1 initial + 1 retry
  });

  it('throws when constructed without an access token', () => {
    assert.throws(() => new MetaClient({ accessToken: '' }), /accessToken/);
  });
});
