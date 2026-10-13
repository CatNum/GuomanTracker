import test from 'node:test';
import assert from 'node:assert/strict';
import { applyConfirmedMembership, applyConfirmedReorder, isDefinitiveBusinessRejection, runLibraryOperation } from '../lib/library-operation.ts';
import { CloudActionError } from '../lib/cloud-auth.ts';
import type { Library } from '../lib/watching.ts';

test('confirmed write stays successful when display refresh fails and recovery only reads', async () => {
  let writes = 0;
  let reads = 0;
  const result = await runLibraryOperation(
    async () => { writes++; return { version: 2 }; },
    async () => { reads++; throw new Error('read offline'); },
    () => false,
  );
  assert.equal(result.kind, 'saved-unrefreshed');
  await assert.rejects(async () => { reads++; throw new Error('still offline'); }, /offline/);
  assert.equal(writes, 1);
  assert.equal(reads, 2);
});

test('uncertain write never reads as saved or automatically retries', async () => {
  let writes = 0;
  let reads = 0;
  const result = await runLibraryOperation(
    async () => { writes++; throw new Error('response lost'); },
    async () => { reads++; return { version: 2 }; },
    () => false,
  );
  assert.equal(result.kind, 'unknown');
  assert.equal(writes, 1);
  assert.equal(reads, 0);
});

test('explicit business rejection remains correctable without a refresh', async () => {
  const rejection = Object.assign(new Error('集数不合法'), { code: 'INVALID_PROGRESS' });
  const result = await runLibraryOperation(
    async () => { throw rejection; },
    async () => { throw new Error('must not read'); },
    (error) => error === rejection,
  );
  assert.deepEqual(result, { kind: 'rejected', error: rejection });
});

test('only known business codes prove rejection; service failure and unknown commit require a read', () => {
  assert.equal(isDefinitiveBusinessRejection(new CloudActionError('版本冲突', 'CONFLICT')), true);
  assert.equal(isDefinitiveBusinessRejection(new CloudActionError('invalid', 'INVALID_PROGRESS')), true);
  assert.equal(isDefinitiveBusinessRejection(new CloudActionError('service failed', 'SERVICE_UNAVAILABLE')), false);
  assert.equal(isDefinitiveBusinessRejection(new CloudActionError('uncertain', 'TX_OUTCOME_UNKNOWN')), false);
  assert.equal(isDefinitiveBusinessRejection(new Error('network')), false);
});

test('unsupported platforms are correctable business rejections without an unknown-write lock', async () => {
  const rejection = new CloudActionError('目前仅支持哔哩哔哩、腾讯视频和优酷。', 'UNSUPPORTED_PLATFORM');
  let refreshes = 0;
  const result = await runLibraryOperation(
    async () => { throw rejection; },
    async () => { refreshes++; throw new Error('must not refresh'); },
    isDefinitiveBusinessRejection,
  );
  assert.deepEqual(result, { kind: 'rejected', error: rejection });
  assert.equal(refreshes, 0);
});

test('unrecognized official metadata is a correctable failure without refresh or a saved state', async () => {
  const rejection = new CloudActionError('补录失败：未能识别官方节目名称，本次未保存任何更改。', 'METADATA_UNAVAILABLE');
  const result = await runLibraryOperation(
    async () => { throw rejection; },
    async () => { throw new Error('rejected submission must not refresh'); },
    isDefinitiveBusinessRejection,
  );
  assert.deepEqual(result, { kind: 'rejected', error: rejection });
});

test('invalid full-order requests are correctable business rejections without an unknown-write lock', () => {
  assert.equal(isDefinitiveBusinessRejection(new CloudActionError('排序必须包含本人全部追番', 'INVALID_ORDER')), true);
});

test('confirmed reorder applies server versions and skips the full-library refresh', async () => {
  const library: Library = { user: { uid: 'u', displayName: 'U' }, series: [], follows: [], priorityOrder: ['a', 'b'], membershipVersion: 4, orderVersion: 7 };
  let refreshes = 0;
  const result = await runLibraryOperation(
    async () => ({ priorityOrder: ['b', 'a'], membershipVersion: 4, orderVersion: 8 }),
    async () => { refreshes++; return library; },
    isDefinitiveBusinessRejection,
    (value) => applyConfirmedReorder(library, ['b', 'a'], value),
  );
  assert.equal(result.kind, 'saved');
  if (result.kind === 'saved') {
    assert.deepEqual(result.library.priorityOrder, ['b', 'a']);
    assert.equal(result.library.membershipVersion, 4);
    assert.equal(result.library.orderVersion, 8);
  }
  assert.equal(refreshes, 0);
});

test('incomplete reorder response keeps the refresh recovery path', async () => {
  const library: Library = { user: { uid: 'u', displayName: 'U' }, series: [], follows: [], priorityOrder: ['a'], membershipVersion: 4, orderVersion: 7 };
  assert.equal(applyConfirmedReorder(library, ['b'], { priorityOrder: ['b'] }), null);
  assert.equal(applyConfirmedReorder(library, ['b'], { priorityOrder: ['b'], membershipVersion: 4, orderVersion: -1 }), null);
  assert.equal(applyConfirmedReorder(library, ['b'], { priorityOrder: ['b'], membershipVersion: 4, orderVersion: 7 }), null);
  let refreshes = 0;
  const result = await runLibraryOperation(
    async () => ({ priorityOrder: ['b'] }),
    async () => { refreshes++; return library; },
    isDefinitiveBusinessRejection,
    (value) => applyConfirmedReorder(library, ['b'], value),
  );
  assert.equal(result.kind, 'saved');
  assert.equal(refreshes, 1);
});

test('confirmed-result failure remains a confirmed write with refresh required', async () => {
  let refreshes = 0;
  const error = new Error('session check failed');
  const result = await runLibraryOperation(
    async () => ({ saved: true }),
    async () => { refreshes++; return 'refreshed'; },
    isDefinitiveBusinessRejection,
    async () => { throw error; },
  );
  assert.deepEqual(result, { kind: 'saved-unrefreshed', error });
  assert.equal(refreshes, 0);
});


const membershipLibrary: Library = { user: { uid: 'u', displayName: 'U' }, series: [],
  follows: [{ seriesId: 'a', currentEpisode: 3, episodeCompleted: true, paused: false, version: 2, updatedAt: '2026-10-12' }],
  priorityOrder: ['a'], membershipVersion: 4, orderVersion: 7 };
const addedFollow = { seriesId: 'b', currentEpisode: 0, episodeCompleted: false, paused: false, version: 1, updatedAt: '2026-10-12' };
const addedSeries = { id: 'b', title: 'B', platform: 'bilibili', url: 'https://www.bilibili.com/bangumi/play/ss2', cover: '', status: 'unknown', episodes: '待核验', events: [], checkedAt: '2026-10-12', source: '官网' };
const addedPatch = { beforeMembershipVersion: 4, beforeOrderVersion: 7, membershipVersion: 5, orderVersion: 7, priorityOrder: ['a', 'b'] };

test('confirmed follow applies only its server record and preserves other progress without reading again', async () => {
  const result = await runLibraryOperation(async () => ({ ...addedFollow, series: addedSeries, libraryPatch: addedPatch }),
    async () => { throw new Error('unnecessary full-library request'); }, isDefinitiveBusinessRejection,
    value => applyConfirmedMembership(membershipLibrary, 'follow', 'b', value));
  assert.equal(result.kind, 'saved');
  if (result.kind === 'saved') {
    assert.deepEqual(result.library.follows, [membershipLibrary.follows[0], addedFollow]);
    assert.deepEqual(result.library.priorityOrder, ['a', 'b']);
    assert.equal(result.library.membershipVersion, 5);
  }
});

test('confirmed unfollow removes only the selected series and uses committed membership versions', () => {
  const result = applyConfirmedMembership(membershipLibrary, 'unfollow', 'a', { seriesId: 'a', libraryPatch: { ...addedPatch, priorityOrder: [] } });
  assert.ok(result);
  assert.deepEqual(result.follows, []);
  assert.deepEqual(result.priorityOrder, []);
  assert.equal(result.membershipVersion, 5);
});

test('concurrent, incomplete and malformed membership responses fall back to a verified full read', () => {
  const response = { ...addedFollow, series: addedSeries, libraryPatch: addedPatch };
  for (const value of [ {}, { ...response, seriesId: 'foreign' },
    { ...response, libraryPatch: { ...addedPatch, beforeMembershipVersion: 5 } },
    { ...response, libraryPatch: { ...addedPatch, beforeOrderVersion: 8 } },
    { ...response, libraryPatch: { ...addedPatch, priorityOrder: ['b'] } },
    { ...response, libraryPatch: { ...addedPatch, priorityOrder: ['a', 'b', 'b'] } },
    { ...response, version: 0 }, { ...response, series: { ...addedSeries, id: 'foreign' } } ]) {
    assert.equal(applyConfirmedMembership(membershipLibrary, 'follow', 'b', value), null);
  }
});
