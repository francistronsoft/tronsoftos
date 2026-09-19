import assert from 'node:assert/strict';
import test from 'node:test';
import { AsyncProbeCache } from './async-probe-cache.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('reuses a fresh value', async () => {
  const cache = new AsyncProbeCache({ ttlMs: 1000, staleMs: 2000 });
  let calls = 0;
  const loader = async () => ++calls;

  assert.equal(await cache.get('db', loader), 1);
  assert.equal(await cache.get('db', loader), 1);
  assert.equal(calls, 1);
});

test('coalesces concurrent and forced loads', async () => {
  const cache = new AsyncProbeCache({ ttlMs: 1000, staleMs: 2000 });
  let calls = 0;
  const loader = async () => {
    calls += 1;
    await delay(20);
    return calls;
  };

  const values = await Promise.all([
    cache.get('db', loader, { force: true }),
    cache.get('db', loader, { force: true }),
    cache.get('db', loader)
  ]);
  assert.deepEqual(values, [1, 1, 1]);
  assert.equal(calls, 1);
});

test('uses a recent stale value when refresh fails', async () => {
  const cache = new AsyncProbeCache({ ttlMs: 0, staleMs: 1000 });
  await cache.get('db', async () => ({ checkedAt: 'original' }));

  const value = await cache.get('db', async () => {
    throw new Error('temporary failure');
  });
  assert.deepEqual(value, { checkedAt: 'original' });
});

test('force and invalidation refresh successful values', async () => {
  const cache = new AsyncProbeCache({ ttlMs: 1000, staleMs: 2000 });
  let calls = 0;
  const loader = async () => ++calls;

  assert.equal(await cache.get('db', loader), 1);
  assert.equal(await cache.get('db', loader, { force: true }), 2);
  cache.invalidate('db');
  assert.equal(await cache.get('db', loader), 3);
});

test('can reject a failed forced refresh instead of using stale data', async () => {
  const cache = new AsyncProbeCache({ ttlMs: 1000, staleMs: 2000 });
  await cache.get('db', async () => 'old');

  await assert.rejects(
    cache.get('db', async () => { throw new Error('refresh failed'); }, { force: true, allowStale: false }),
    /refresh failed/
  );
});

test('applies stale policy per caller while sharing a failed load', async () => {
  const cache = new AsyncProbeCache({ ttlMs: 0, staleMs: 2000 });
  await cache.get('db', async () => 'old');
  const failingLoader = async () => {
    await delay(20);
    throw new Error('shared failure');
  };

  const automatic = cache.get('db', failingLoader);
  const manual = cache.get('db', failingLoader, { force: true, allowStale: false });
  assert.equal(await automatic, 'old');
  await assert.rejects(manual, /shared failure/);
});

test('does not share values across keys', async () => {
  const cache = new AsyncProbeCache({ ttlMs: 1000, staleMs: 2000 });
  assert.equal(await cache.get('db-a', async () => 'a'), 'a');
  assert.equal(await cache.get('db-b', async () => 'b'), 'b');
});
