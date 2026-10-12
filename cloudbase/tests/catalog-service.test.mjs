import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogService } from '../shared/catalog-service.mjs';

const seed = [
  { id: 'bili-12', title: '旧标题', platform: 'bilibili', events: [], checkedAt: 'old' },
  { id: 'tx-1', platform: 'tencent' }, { id: 'yk-1', platform: 'youku' }, { id: 'iq-1', platform: 'iqiyi' },
];
const episode = (season_id, extras = {}) => ({ season_id, pub_ts: 1790996400, title: `作品${season_id}`, pub_index: '第1话', ...extras });
const response = (episodes = [episode(12), episode(13)]) => new Response(JSON.stringify({ code: 0, result: [{ episodes }] }));

test('merges official episodes, filters unsupported platforms, and caches successful result for ten minutes', async () => {
  let calls = 0;
  let clock = 1000;
  const service = createCatalogService({ loadSeed: async () => seed, fetchImpl: async (url) => { calls++; assert.match(url, /^https:\/\/api\.bilibili\.com\//); return response([episode(12), episode(13, { cover: 'http://i1.hdslb.com/bfs/cover.png' }), episode(14, { cover: 'https://evil.example/cover.png' })]); }, now: () => clock });
  const first = await service.getCatalog();
  assert.equal(first.live, true);
  assert.deepEqual(first.items.map((item) => item.platform), ['bilibili', 'tencent', 'youku', 'bilibili', 'bilibili']);
  assert.equal(first.items[0].events[0].at, 1790996400000);
  assert.equal(first.items[3].cover, 'https://i1.hdslb.com/bfs/cover.png');
  assert.equal(first.items[4].cover, '');
  assert.equal(calls, 1);
  clock += 599_999;
  await service.getCatalog();
  assert.equal(calls, 1);
  clock += 2;
  await service.getCatalog();
  assert.equal(calls, 2);
});

test('limits response bytes while streaming and falls back on oversized or malformed responses', async () => {
  const oversized = { ok: true, body: { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(2 * 1024 * 1024 + 1) }), cancel: async () => {}, releaseLock() {} }) } };
  for (const fetchImpl of [async () => oversized, async () => new Response('{"code":0,"result":[{"episodes":[{"season_id":"bad"}]}]}')]) {
    const result = await createCatalogService({ loadSeed: async () => seed, fetchImpl }).getCatalog();
    assert.equal(result.live, false);
    assert.deepEqual(result.items.map((item) => item.platform), ['bilibili', 'tencent', 'youku']);
  }
});

test('falls back when an official timestamp cannot be represented as a JavaScript date', async () => {
  for (const timestamp of [Number.MAX_SAFE_INTEGER, 8.64e12, 8.64e12 - 8 * 60 * 60 + 1]) {
    const service = createCatalogService({ loadSeed: async () => seed, fetchImpl: async () => response([episode(15, { pub_ts: timestamp })]) });
    const result = await service.getCatalog();
    assert.equal(result.live, false, `timestamp ${timestamp} must fall back`);
    assert.deepEqual(result.items.map((item) => item.platform), ['bilibili', 'tencent', 'youku']);
  }
});

test('uses a ten-second abort signal and retries after a failed request without caching fallback', async () => {
  let calls = 0;
  let signal;
  let timeoutMs;
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (milliseconds) => { timeoutMs = milliseconds; return originalTimeout(milliseconds); };
  try {
    const service = createCatalogService({ loadSeed: async () => seed, fetchImpl: async (_url, options) => {
      calls++; signal = options.signal;
      if (calls === 1) throw new Error('timeout');
      return response([]);
    } });
    assert.equal((await service.getCatalog()).live, false);
    assert.equal(timeoutMs, 10_000);
    assert.equal(signal.aborted, false);
    assert.equal((await service.getCatalog()).live, true);
    assert.equal(calls, 2);
  } finally { AbortSignal.timeout = originalTimeout; }
});

test('coalesces concurrent requests and clears rejected in-flight work', async () => {
  let calls = 0;
  let release;
  const service = createCatalogService({ loadSeed: async () => seed, fetchImpl: async () => { calls++; await new Promise((resolve) => { release = resolve; }); return response([]); } });
  const one = service.getCatalog();
  const two = service.getCatalog();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await one, await two);
});
