const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const { retry } = require('../utils/Retry');

const retryable = (msg = 'transient') => Object.assign(new Error(msg), { retryable: true });
const fatal = (msg = 'fatal') => Object.assign(new Error(msg), { retryable: false });

// 1ms base delay keeps the backoff real but the suite fast.
const FAST = { baseDelayMs: 1 };

/** A mock that rejects with each given error in turn, then resolves `value`. */
function failThen(errors, value) {
  let i = 0;
  return mock.fn(async () => {
    if (i < errors.length) throw errors[i++];
    return value;
  });
}

describe('retry', () => {
  it('retries retryable failures then resolves', async () => {
    const fn = failThen([retryable(), retryable()], 'ok');
    assert.equal(await retry(fn, { ...FAST, retries: 3 }), 'ok');
    assert.equal(fn.mock.callCount(), 3);
  });

  it('fails fast on non-retryable errors', async () => {
    const fn = mock.fn(async () => {
      throw fatal('nope');
    });
    await assert.rejects(retry(fn, { ...FAST, retries: 3 }), /nope/);
    assert.equal(fn.mock.callCount(), 1);
  });

  it('gives up after the configured number of retries', async () => {
    const fn = mock.fn(async () => {
      throw retryable('always');
    });
    await assert.rejects(retry(fn, { ...FAST, retries: 2 }), /always/);
    assert.equal(fn.mock.callCount(), 3); // 1 initial + 2 retries
  });

  it('invokes onRetry with the attempt number and delay', async () => {
    const onRetry = mock.fn();
    const fn = failThen([retryable()], 'ok');
    assert.equal(await retry(fn, { ...FAST, retries: 3, onRetry }), 'ok');
    assert.equal(onRetry.mock.callCount(), 1);
    const [, attempt, delay] = onRetry.mock.calls[0].arguments;
    assert.equal(attempt, 1);
    assert.ok(delay > 0);
  });
});
