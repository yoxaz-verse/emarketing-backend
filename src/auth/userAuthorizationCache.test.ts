import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthorizationCache } from './userAuthorizationCache.js';

test('authorization cache reuses values until the ttl expires', async () => {
  let clock = 1_000;
  let calls = 0;
  const cache = createAuthorizationCache(async () => ({ calls: ++calls }), 60_000, () => clock);
  assert.deepEqual(await cache.get('user-1'), { calls: 1 });
  assert.deepEqual(await cache.get('user-1'), { calls: 1 });
  clock += 60_001;
  assert.deepEqual(await cache.get('user-1'), { calls: 2 });
});

test('authorization cache coalesces concurrent misses', async () => {
  let release!: () => void;
  let calls = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const cache = createAuthorizationCache(async () => {
    calls += 1;
    await gate;
    return { active: true };
  });
  const first = cache.get('user-1');
  const second = cache.get('user-1');
  release();
  assert.deepEqual(await Promise.all([first, second]), [{ active: true }, { active: true }]);
  assert.equal(calls, 1);
});

test('authorization cache does not cache misses or failures', async () => {
  let calls = 0;
  const missing = createAuthorizationCache(async () => { calls += 1; return null; });
  await missing.get('user-1');
  await missing.get('user-1');
  assert.equal(calls, 2);

  const failing = createAuthorizationCache(async () => { calls += 1; throw new Error('offline'); });
  await assert.rejects(failing.get('user-2'), /offline/);
  await assert.rejects(failing.get('user-2'), /offline/);
  assert.equal(calls, 4);
});
