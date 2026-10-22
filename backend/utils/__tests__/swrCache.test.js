const test = require('node:test');
const assert = require('node:assert/strict');
const { createSwrCache } = require('../swrCache');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('cold get awaits the first load; a fresh get does not load again', async () => {
  let loads = 0;
  const c = createSwrCache({ name: 't', ttlMs: 1000, load: async () => ({ n: ++loads }) });
  assert.equal(c.peek(), null);
  const v1 = await c.get();
  assert.deepEqual(v1, { n: 1 });
  const v2 = await c.get();
  assert.equal(v2, v1);
  assert.equal(loads, 1);
  assert.equal(c.stats().stale, false);
});

test('stale get returns the old value at once and triggers exactly one refresh', async () => {
  let loads = 0;
  const gate = deferred();
  const c = createSwrCache({
    name: 't',
    ttlMs: 20,
    load: async () => { loads += 1; if (loads > 1) await gate.promise; return { n: loads }; },
  });
  const first = await c.get();
  await sleep(30);
  const a = await c.get();
  const b = await c.get();
  assert.equal(a, first);
  assert.equal(b, first);
  assert.equal(loads, 2);
  assert.equal(c.stats().refreshing, true);
  gate.resolve();
  await sleep(0);
  assert.deepEqual(await c.get(), { n: 2 });
});

test('concurrent cold gets share one in-flight load', async () => {
  let loads = 0;
  const c = createSwrCache({ name: 't', ttlMs: 1000, load: async () => { loads += 1; await sleep(5); return loads; } });
  const [a, b, d] = await Promise.all([c.get(), c.get(), c.get()]);
  assert.equal(loads, 1);
  assert.deepEqual([a, b, d], [1, 1, 1]);
});

test('invalidate mid-load leaves the just-loaded value stale', async () => {
  const gate = deferred();
  let loads = 0;
  const c = createSwrCache({ name: 't', ttlMs: 1000, load: async () => { loads += 1; await gate.promise; return loads; } });
  const p = c.get();
  c.invalidate(); // a write lands while the read is in flight
  gate.resolve();
  assert.equal(await p, 1);
  assert.equal(c.stats().stale, true);
  assert.equal(await c.get(), 1); // stale: served now…
  await sleep(0);
  assert.equal(loads, 2); // …and reloaded behind, this time seeing the write
});

test('invalidate after a fresh load makes the next get reload', async () => {
  let loads = 0;
  const c = createSwrCache({ name: 't', ttlMs: 1000, load: async () => ++loads });
  await c.get();
  c.invalidate();
  assert.equal(c.stats().stale, true);
  assert.equal(await c.get(), 1); // old value served, refresh kicked
  await sleep(0);
  assert.equal(loads, 2);
  assert.equal(await c.get(), 2);
});

test('load failure: rejects when cold, keeps the old value when warm', async () => {
  let fail = false;
  const c = createSwrCache({ name: 't', ttlMs: 20, load: async () => { if (fail) throw new Error('boom'); return 'ok'; } });
  fail = true;
  await assert.rejects(c.get(), /boom/);
  assert.equal(c.stats().error, 'boom');
  fail = false;
  assert.equal(await c.get(), 'ok');
  assert.equal(c.stats().error, null);
  await sleep(30);
  fail = true;
  assert.equal(await c.get(), 'ok'); // stale value survives the failed refresh
  await sleep(0);
  assert.equal(c.stats().error, 'boom');
  assert.equal(c.peek(), 'ok');
});

test('peek never awaits and kicks a refresh when stale; load receives prev', async () => {
  const seen = [];
  let loads = 0;
  const c = createSwrCache({ name: 't', ttlMs: 20, load: async (prev) => { seen.push(prev); return ++loads; } });
  assert.equal(c.peek(), null);
  await sleep(0);
  assert.equal(await c.get(), 1);
  await sleep(30);
  assert.equal(c.peek(), 1);
  await sleep(0);
  assert.equal(await c.get(), 2);
  assert.deepEqual(seen, [null, 1]);
});

test('refresh forces a load and is shared while in flight', async () => {
  let loads = 0;
  const c = createSwrCache({ name: 't', ttlMs: 1000, load: async () => { loads += 1; await sleep(5); return loads; } });
  await c.get();
  const [a, b] = await Promise.all([c.refresh(), c.refresh()]);
  assert.equal(a, 2);
  assert.equal(b, 2);
  assert.equal(loads, 2);
});
