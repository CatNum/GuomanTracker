import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogService, createCatalogHandler } from '../shared/catalog-service.mjs';
const series = { _id: 'bili-12', id: 'bili-12', title: '数据库节目', platform: 'bilibili',
  url: 'https://www.bilibili.com/bangumi/play/ss12', cover: '', status: 'ongoing',
  episodes: '更新至12集', events: [], checkedAt: '2026-10-13T00:00:00Z', source: 'official',
  latestEpisode: 12, submittedBy: 'private-user', owner: 'private-user', scanError: 'private-details' };
test('public catalog reads PG without an account and exposes only public program fields', async () => {
  const handler = createCatalogHandler({ createStore: () => ({ listSeriesPage: async () => ({ documents: [series], next_after: '' }) }) });
  const result = await handler({ action: 'getCatalog', payload: {} });
  assert.equal(result.ok, true);
  assert.equal(result.data.items[0].title, '数据库节目');
  assert.equal(result.data.items[0].latestEpisode, 12);
  for (const key of ['_id', 'owner', 'submittedBy', 'scanError']) assert.equal(key in result.data.items[0], false);
});
test('catalog rejects writes and arbitrary payloads before accessing PG', async () => {
  const handler = createCatalogHandler({ createStore: () => { throw Error('must not construct a manager'); } });
  for (const event of [null, {}, { action: 'progress', payload: {} }, { action: 'getCatalog', payload: { owner: 'alice' } },
    { action: 'getCatalog', payload: { after: 12 } }, { action: 'getCatalog', payload: { after: 'x'.repeat(257) } }]) {
    assert.equal((await handler(event)).error.code, 'INVALID_REQUEST');
  }
});
test('PG errors never become a successful empty catalog or a file fallback', async () => {
  const handler = createCatalogHandler({ createStore: () => ({ listSeriesPage: async () => { throw Error('private SQL details'); } }) });
  const result = await handler({ action: 'getCatalog', payload: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'SERVICE_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(result), /private SQL/);
});
test('catalog retains database schedule and confirmed episode fields', async () => {
  const service = createCatalogService({ store: { listSeriesPage: async () => ({ documents: [
    { ...series, scheduleCheckedAt: '2026-10-12', days: [6], time: '11:00', schedule: '周六11点' },
  ], next_after: '' }) } });
  const result = await service.getCatalog({ after: '' });
  assert.deepEqual(result.items[0].days, [6]);
  assert.equal(result.items[0].scheduleCheckedAt, '2026-10-12');
  assert.equal(result.nextAfter, '');
});
