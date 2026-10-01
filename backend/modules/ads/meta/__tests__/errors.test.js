const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  toMetaError,
  MetaRateLimitError,
  MetaAuthError,
  MetaPermissionError,
  MetaValidationError,
  MetaServerError,
} = require('../utils/Errors');

describe('toMetaError classification', () => {
  it('maps HTTP 429 to a retryable rate-limit error', () => {
    const err = toMetaError(429, { error: { message: 'slow down' } });
    assert.ok(err instanceof MetaRateLimitError);
    assert.equal(err.retryable, true);
  });

  it('maps a throttling code (4) to a rate-limit error even on a 400', () => {
    assert.ok(toMetaError(400, { error: { code: 4 } }) instanceof MetaRateLimitError);
  });

  it('maps token code 190 to a non-retryable auth error', () => {
    const err = toMetaError(400, { error: { code: 190, message: 'bad token' } });
    assert.ok(err instanceof MetaAuthError);
    assert.equal(err.retryable, false);
  });

  it('maps permission codes (10 and 200-299) to permission errors', () => {
    assert.ok(toMetaError(403, { error: { code: 10 } }) instanceof MetaPermissionError);
    assert.ok(toMetaError(403, { error: { code: 200 } }) instanceof MetaPermissionError);
    assert.ok(toMetaError(403, { error: { code: 299 } }) instanceof MetaPermissionError);
  });

  it('maps 5xx to a retryable server error', () => {
    const err = toMetaError(503, {});
    assert.ok(err instanceof MetaServerError);
    assert.equal(err.retryable, true);
  });

  it('maps other 4xx to a non-retryable validation error', () => {
    const err = toMetaError(400, { error: { code: 100, message: 'invalid field' } });
    assert.ok(err instanceof MetaValidationError);
    assert.equal(err.retryable, false);
  });

  it('prefers the user-facing message when present', () => {
    const err = toMetaError(400, {
      error: { code: 100, message: 'raw', error_user_msg: 'friendly' },
    });
    assert.equal(err.message, 'friendly');
  });

  it('captures code, subcode, type, and fbtrace id', () => {
    const err = toMetaError(400, {
      error: { code: 100, error_subcode: 33, type: 'OAuthException', fbtrace_id: 'abc' },
    });
    assert.equal(err.code, 100);
    assert.equal(err.subcode, 33);
    assert.equal(err.type, 'OAuthException');
    assert.equal(err.fbtraceId, 'abc');
  });

  it('preserves the concrete class name on the error instance', () => {
    assert.equal(toMetaError(429, {}).name, 'MetaRateLimitError');
  });
});
