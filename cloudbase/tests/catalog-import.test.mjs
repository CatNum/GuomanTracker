import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCatalog, catalogImportSql, catalogLinkNormalization } from '../shared/catalog-import.mjs';
const item = { id: 'bili-12', title: '作品', platform: 'bilibili', url: 'https://www.bilibili.com/bangumi/play/ss12?tracking=1',
  cover: '', status: 'ongoing', episodes: '更新至12集', checkedAt: '2026-10-13T00:00:00Z', source: 'official', events: [] };
test('migration retains program IDs while normalizing links and stripping untrusted fields', () => {
  const [record] = prepareCatalog([{ ...item, owner: 'private', submittedBy: 'private' }]);
  assert.equal(record.id, 'bili-12');
  assert.equal(record.url, 'https://www.bilibili.com/bangumi/play/ss12');
  assert.equal(record._id, 'bili-12');
  assert.equal('owner' in record, false);
  assert.equal('submittedBy' in record, false);
});
test('legacy link normalization retains IDs, progress-independent metadata and exact concurrency baseline', () => {
  const old = { ...item, _id: 'bili-12', url: 'https://www.bilibili.com/bangumi/play/ss12?theme=movie',
    latestEpisode: 99, monitoring: 'active', checkedAt: '2026-10-13T12:00:00Z' };
  const batch = catalogLinkNormalization([old]);
  assert.deepEqual(batch.reads, [{ collection: 'guoman_series', id: 'bili-12', exists: true, document: old }]);
  assert.deepEqual(batch.writes[0].document, { ...old, url: 'https://www.bilibili.com/bangumi/play/ss12' });
  assert.deepEqual(catalogLinkNormalization([batch.writes[0].document]), { reads: [], writes: [] });
});
test('all input validation completes before any migration statement is generated', () => {
  for (const items of [[item,item], [{ ...item, checkedAt: 'invalid' }], [{ ...item, id: '' }], [{ ...item, url: 'https://evil.example/' }]])
    assert.throws(() => prepareCatalog(items));
  assert.throws(() => catalogImportSql(Array.from({ length: 101 }, () => item)));
});
test('administrator updates cannot persist malformed schedule or release fields that break catalog reads', () => {
  for (const fields of [{ latestEpisode: '12' }, { latestEpisode: 0 }, { days: [7] }, { days: '周六' },
    { time: '25:00' }, { scheduleCheckedAt: 'invalid' }, { metadataPending: 'yes' }, { episodes: '集'.repeat(201) }]) {
    assert.throws(() => prepareCatalog([{ ...item, ...fields }]));
  }
});
test('initial import and explicit update use the fixed PG ingestion function with explicit intent', () => {
  const records = prepareCatalog([item]);
  const first = catalogImportSql(records);
  assert.match(first, /^SELECT guoman_private\.ingest_series_batch\(/u);
  assert.doesNotMatch(first, /DELETE|TRUNCATE|guoman_watch_state/u);
  const args = sql => JSON.parse(Buffer.from(/decode\('([0-9a-f]+)'/u.exec(sql)[1], 'hex').toString('utf8'));
  assert.equal(args(first).update, false);
  const update = catalogImportSql(records, { update: true });
  assert.equal(args(update).update, true);
  assert.equal(args(update).items[0].id, 'bili-12');
});
