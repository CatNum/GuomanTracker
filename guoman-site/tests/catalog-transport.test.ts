import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalogData } from '../lib/catalog-transport.ts';
const series = { id: 'a', title: 'PG节目', platform: 'bilibili', url: 'https://www.bilibili.com/bangumi/play/ss12',
  cover: '', status: 'ongoing', episodes: '更新至12集', checkedAt: '2026-10-13', source: 'PG', events: [], latestEpisode: 12 };
test('guest reads all PG pages without an authenticated session', async () => {
  const data = await loadCatalogData({ call: async (_action, payload) => payload.after
    ? { items: [{ ...series, id: 'b' }], nextAfter: '' }
    : { items: [series], nextAfter: 'a' } });
  assert.deepEqual(data.items.map(item => item.id), ['a', 'b']);
  assert.equal(data.items[0].latestEpisode, 12);
});
test('a later page failure rejects the whole read, allowing callers to keep previous data', async () => {
  await assert.rejects(loadCatalogData({ call: async (_action, payload) => {
    if (payload.after) throw Error('database unavailable');
    return { items: [series], nextAfter: 'a' };
  } }), /database unavailable/);
});
test('malformed or looping cursors cannot silently truncate or loop forever', async () => {
  for (const response of [{}, { items: [], nextAfter: 'a' }, { items: [series], nextAfter: 'z' }]) {
    await assert.rejects(loadCatalogData({ call: async () => response }));
  }
  await assert.rejects(loadCatalogData({ call: async () => ({ items: [series], nextAfter: 'a' }) }));
});
