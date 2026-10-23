const test = require('node:test');
const assert = require('node:assert/strict');

function fresh() {
  delete require.cache[require.resolve('../env')];
  return require('../env');
}

test('num: unset, empty and garbage fall back; numbers parse', () => {
  delete process.env.X_NUM;
  assert.equal(fresh().num('X_NUM', 7), 7);
  process.env.X_NUM = '';
  assert.equal(fresh().num('X_NUM', 7), 7);
  process.env.X_NUM = 'abc';
  assert.equal(fresh().num('X_NUM', 7), 7);
  process.env.X_NUM = '42';
  assert.equal(fresh().num('X_NUM', 7), 42);
  process.env.X_NUM = '0';
  assert.equal(fresh().num('X_NUM', 7), 0);
  delete process.env.X_NUM;
});

test('str: unset and empty fall back; anything else is returned as a string', () => {
  delete process.env.X_STR;
  assert.equal(fresh().str('X_STR', 'd'), 'd');
  process.env.X_STR = '';
  assert.equal(fresh().str('X_STR', 'd'), 'd');
  process.env.X_STR = 'v';
  assert.equal(fresh().str('X_STR', 'd'), 'v');
  delete process.env.X_STR;
});

test('bool: truthy spellings, falsy spellings, default', () => {
  delete process.env.X_BOOL;
  assert.equal(fresh().bool('X_BOOL'), false);
  assert.equal(fresh().bool('X_BOOL', true), true);
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
    process.env.X_BOOL = v;
    assert.equal(fresh().bool('X_BOOL'), true, v);
  }
  for (const v of ['0', 'false', 'no', 'off', 'maybe']) {
    process.env.X_BOOL = v;
    assert.equal(fresh().bool('X_BOOL', true), false, v);
  }
  delete process.env.X_BOOL;
});

test('shared constants carry their documented defaults', () => {
  for (const k of ['TELECMI_MIN_DURATION_SEC', 'TRANSCRIBE_SCOPE', 'BIGIN_WON_STAGE', 'CAMPAIGN_INDEX_TTL_MS', 'MONGO_URI']) {
    delete process.env[k];
  }
  const env = fresh();
  assert.equal(env.TELECMI_MIN_DURATION_SEC, 30);
  assert.equal(env.TRANSCRIBE_SCOPE, 'won');
  assert.equal(env.BIGIN_WON_STAGE, 'Closed with Sale');
  assert.equal(env.CAMPAIGN_INDEX_TTL_MS, 60000);
  assert.match(env.MONGO_URI, /^mongodb:\/\//);
  process.env.TRANSCRIBE_SCOPE = 'ALL';
  assert.equal(fresh().TRANSCRIBE_SCOPE, 'all');
  delete process.env.TRANSCRIBE_SCOPE;
});
