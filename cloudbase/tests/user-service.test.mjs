import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createUserService } from '../shared/user-service.mjs';
import { createCloudbaseStore } from '../shared/cloudbase-store.mjs';
import { latestPublishedEpisode } from '../shared/published-episode.mjs';
import { CommitUnconfirmedError } from '../shared/pg-store.mjs';

test('SCF CommonJS entry exposes its callable index.main without loading network dependencies', () => {
  const require = createRequire(import.meta.url);
  assert.equal(typeof require('../functions/guoman-user/index.js').main, 'function');
});

// This boundary implementation provides isolated, atomic document transactions.
// The service itself makes every ownership, quota, and progress decision.
class MemoryStore {
  maps = new Map();
  queue = Promise.resolve();
  async get(collection, id) { return structuredClone(this.maps.get(`${collection}/${id}`) ?? null); }
  async put(collection, id, data) { this.maps.set(`${collection}/${id}`, structuredClone(data)); }
  async remove(collection, id) { this.maps.delete(`${collection}/${id}`); }
  async listFollows(owner) {
    return [...this.maps.entries()].filter(([key, value]) => key.startsWith('guoman_watch_state/') && value.owner === owner && value.kind === 'follow').map(([, value]) => structuredClone(value));
  }
  transaction(callback) {
    const result = this.queue.then(async () => {
      const before = structuredClone(this.maps);
      try { return await callback(this); } catch (error) { this.maps = before; throw error; }
    });
    this.queue = result.catch(() => {});
    return result;
  }
}

const seed = [{ id: 'bili-seed', title: '已收录国漫', platform: 'bilibili', url: 'https://www.bilibili.com/bangumi/play/ss123', cover: '', status: '连载', episodes: '更新至10话', events: [], checkedAt: '2026-10-05T00:00:00.000Z', source: '官方目录', latestEpisode: 10 }];
function setup(start = '2026-10-05T00:00:00.000Z') {
  const store = new MemoryStore();
  let clock = new Date(start);
  const service = createUserService({ store, seed, now: () => clock });
  const call = (uid, action, payload = {}, extra = {}) => service({ action, payload, ...extra }, { uid, displayName: uid });
  return { store, call, advance: (milliseconds = 86400000) => { clock = new Date(clock.getTime() + milliseconds); } };
}

test('anonymous and forged payload uid cannot read or mutate another account', async () => {
  const { call } = setup();
  assert.equal((await call('', 'library', {}, { uid: 'alice' })).error.code, 'UNAUTHENTICATED');
  await call('alice', 'follow', { seriesId: 'bili-seed' });
  const library = await call('bob', 'library', { uid: 'alice' });
  assert.deepEqual(library.data.follows, []);
  assert.equal((await call('bob', 'progress', { seriesId: 'bili-seed', currentEpisode: 4, episodeCompleted: false, paused: false, version: 1, uid: 'alice' })).error.code, 'NOT_FOLLOWING');
  assert.equal((await call('alice', 'library')).data.follows[0].currentEpisode, 0);
});

test('known official links preserve catalog identifiers and repeated submissions deduplicate', async () => {
  const { call, store } = setup();
  const existing = await call('alice', 'submit', { title: '自定义名称', url: `${seed[0].url}?spm_id_from=share` });
  assert.equal(existing.data.series.id, 'bili-seed');
  assert.equal(existing.data.series.title, '已收录国漫');
  const first = await call('alice', 'submit', { title: '用户补录动画', url: 'https://www.bilibili.com/bangumi/play/ss456?from=share' });
  const second = await call('bob', 'submit', { title: '不同名字', url: 'https://www.bilibili.com/bangumi/play/ss456' });
  assert.equal(first.data.series.id, second.data.series.id);
  assert.equal(first.data.series.title, second.data.series.title);
  const targets = [...store.maps.keys()].filter((key) => key.startsWith('guoman_monitor_targets/'));
  assert.equal(targets.length, 2);
  assert.equal((await call('bob', 'library')).data.follows.length, 1);
});

test('official-link-only submissions preserve known titles and use a pending title for new shows', async () => {
  const { call } = setup();
  const known = await call('alice', 'submit', { url: seed[0].url });
  assert.equal(known.data.series.title, '已收录国漫');
  const fresh = await call('alice', 'submit', { url: 'https://www.bilibili.com/bangumi/play/ss456' });
  assert.equal(fresh.data.series.title, 'B站待核验节目 ss456');
  assert.equal(fresh.data.series.episodes, '待核验');
  assert.equal(fresh.data.series.monitoring, 'queued');
});

test('unsupported platforms reject submit, follow, progress, and open while unfollow remains available', async () => {
  const iqiyi = { id: 'iqiyi-seed', title: '旧平台节目', platform: 'iqiyi', url: 'https://www.iqiyi.com/a_abc.html' };
  const { call, store } = setup();
  const service = createUserService({ store, seed: [...seed, iqiyi] });
  const invoke = (action, payload) => service({ action, payload }, { uid: 'alice' });
  for (const [action, payload] of [
    ['submit', { url: iqiyi.url }], ['follow', { seriesId: iqiyi.id }],
    ['progress', { seriesId: iqiyi.id }], ['open', { seriesId: iqiyi.id }],
  ]) assert.equal((await invoke(action, payload)).error.code, 'UNSUPPORTED_PLATFORM');
  assert.equal((await invoke('unfollow', { seriesId: iqiyi.id })).ok, true);
});

test('daily submission limit is atomic, excludes duplicates and resets in China time', async () => {
  const { call, store, advance } = setup();
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => call('alice', 'submit', { title: `补录${index}`, url: `https://www.bilibili.com/bangumi/play/ss${1000 + index}` })));
  assert.equal(results.filter((result) => result.ok).length, 10);
  assert.equal(results.filter((result) => result.error?.code === 'RATE_LIMITED').length, 2);
  assert.equal((await call('alice', 'submit', { title: '重复补录', url: 'https://www.bilibili.com/bangumi/play/ss1000' })).ok, true);
  assert.equal([...store.maps.keys()].filter((key) => key.startsWith('guoman_series/')).length, 10);
  advance();
  assert.equal((await call('alice', 'submit', { title: '第二天', url: 'https://www.bilibili.com/bangumi/play/ss9999' })).ok, true);
});

test('progress prevents stale overwrites and invalid episode/completion values', async () => {
  const { call } = setup();
  await call('alice', 'follow', { seriesId: 'bili-seed' });
  const payload = { seriesId: 'bili-seed', currentEpisode: 3, episodeCompleted: false, paused: false, version: 1 };
  const results = await Promise.all([call('alice', 'progress', payload), call('alice', 'progress', { ...payload, currentEpisode: 5 })]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.error?.code === 'CONFLICT').length, 1);
  for (const patch of [{ currentEpisode: 11 }, { currentEpisode: -1 }, { currentEpisode: 1.5 }, { episodeCompleted: undefined }, { episodeCompleted: "yes" }, { currentEpisode: 0, episodeCompleted: true }, { paused: 'no' }, { version: undefined }]) {
    assert.equal((await call('alice', 'progress', { ...payload, version: 2, ...patch })).error.code, 'INVALID_PROGRESS');
  }
  const corrected = await call('alice', 'progress', { ...payload, currentEpisode: 1, episodeCompleted: false, version: 2 });
  assert.equal(corrected.data.currentEpisode, 1);
  assert.equal(corrected.data.version, 3);
});

test('daily quota resets at Shanghai midnight rather than UTC midnight', async () => {
  const { call, advance } = setup('2026-10-05T15:59:00.000Z');
  for (let index = 0; index < 10; index++) assert.equal((await call('alice', 'submit', { title: `补录${index}`, url: `https://www.bilibili.com/bangumi/play/ss${3000 + index}` })).ok, true);
  const next = { title: '明日追番', url: 'https://www.bilibili.com/bangumi/play/ss4000' };
  assert.equal((await call('alice', 'submit', next)).error.code, 'RATE_LIMITED');
  advance(60000);
  assert.equal((await call('alice', 'submit', next)).ok, true);
});

test('opening official playback updates timestamp without counting a completed episode', async () => {
  const { call } = setup();
  await call('alice', 'follow', { seriesId: 'bili-seed' });
  await call('alice', 'progress', { seriesId: 'bili-seed', currentEpisode: 4, episodeCompleted: false, paused: false, version: 1 });
  const opened = await call('alice', 'open', { seriesId: 'bili-seed' });
  assert.equal(opened.data.currentEpisode, 4);
  assert.equal(opened.data.episodeCompleted, false);
  assert.ok(opened.data.lastOpenedAt);
  assert.equal((await call('alice', 'open', { seriesId: 'bili-seed' })).data.version, 2);
  assert.equal((await call('bob', 'unfollow', { seriesId: 'bili-seed' })).ok, true);
  assert.equal((await call('alice', 'library')).data.follows.length, 1);
});

test('validation errors and internal failures use safe envelopes', async () => {
  const { call } = setup();
  assert.equal((await call('alice', 'submit', { title: '非法', url: 'https://example.com/ss1' })).error.code, 'INVALID_URL');
  assert.equal((await call('alice', 'submit', { title: '超长链接', url: `https://www.bilibili.com/bangumi/play/ss100?tracking=${'x'.repeat(2048)}` })).error.code, 'INVALID_URL');
  assert.equal((await call('alice', 'follow', { seriesId: 'unknown' })).error.code, 'NOT_FOUND');
  const service = createUserService({ store: { listFollows: async () => { throw new Error('SECRET_INTERNAL'); } }, seed });
  const result = await service({ action: 'library' }, { uid: 'alice' });
  assert.equal(result.error.code, 'SERVICE_UNAVAILABLE');
  assert.ok(!JSON.stringify(result).includes('SECRET_INTERNAL'));
});

test('uncertain PG commit returns a distinct refresh-required envelope without leaking its cause', async () => {
  const store = {
    transaction: async () => { throw new CommitUnconfirmedError(new Error('PRIVATE_NETWORK_DETAIL')); },
  };
  const service = createUserService({ store, seed });
  const result = await service({ action: 'unfollow', payload: { seriesId: 'bili-seed' } }, { uid: 'alice' });
  assert.deepEqual(result, {
    ok: false,
    error: { code: 'TX_OUTCOME_UNKNOWN', message: '保存结果未确认，请刷新记录' },
  });
  assert.ok(!JSON.stringify(result).includes('PRIVATE_NETWORK_DETAIL'));
});

test('CloudBase anonymous identities with a uid are rejected', async () => {
  const service = createUserService({ store: new MemoryStore(), seed });
  assert.equal((await service({ action: 'library' }, { uid: 'anonymous-uid', isAnonymous: true })).error.code, 'UNAUTHENTICATED');
});

test('database adapter treats SDK error envelopes as failures and handles both read shapes', async () => {
  let response = { data: [{ id: 'series' }] };
  const sdkDoc = { get: async () => response, set: async () => ({ code: 'DATABASE_REQUEST_FAILED', message: 'internal' }), remove: async () => ({ code: 'DATABASE_REQUEST_FAILED' }) };
  const database = { collection: () => ({ doc: () => sdkDoc }) };
  const store = createCloudbaseStore(database);
  assert.deepEqual(await store.get('collection', 'id'), { id: 'series' });
  response = { data: { id: 'transaction-series' } };
  assert.deepEqual(await store.get('collection', 'id'), { id: 'transaction-series' });
  response = { data: [] };
  assert.equal(await store.get('collection', 'id'), null);
  response = { code: 'DATABASE_REQUEST_FAILED', message: 'internal' };
  await assert.rejects(() => store.get('collection', 'id'));
  await assert.rejects(() => store.put('collection', 'id', { title: 'series' }));
  await assert.rejects(() => store.remove('collection', 'id'));
});

const manySeed = (count) => Array.from({ length: count }, (_, index) => ({ ...seed[0], id: `bili-limit-${index}`, url: `https://www.bilibili.com/bangumi/play/ss${50000 + index}` }));

test('following a catalog title queues monitoring once without resetting active scan state', async () => {
  const { call, store } = setup();
  assert.equal((await call('alice', 'follow', { seriesId: 'bili-seed' })).ok, true);
  const key = 'guoman_monitor_targets/bili-seed';
  assert.equal(store.maps.get(key)?.source, 'user');
  assert.equal(store.maps.get(key)?.status, 'queued');
  assert.equal(store.maps.get(key)?.seriesId, 'bili-seed');
  store.maps.set(key, { ...store.maps.get(key), status: 'active', failureCount: 3, nextScanAt: '2026-10-09T00:00:00.000Z' });
  await call('alice', 'follow', { seriesId: 'bili-seed' });
  await call('bob', 'follow', { seriesId: 'bili-seed' });
  assert.equal(store.maps.get(key).nextScanAt, '2026-10-09T00:00:00.000Z');
  assert.equal(store.maps.get(key).failureCount, 3);
  assert.equal(store.maps.get(key).status, 'active');
});

test('daily new-monitor budget rejects the 21st target, permits shared targets, and resets', async () => {
  const store = new MemoryStore();
  const catalog = manySeed(23);
  let clock = new Date('2026-10-05T15:59:00.000Z');
  const service = createUserService({ store, seed: catalog, now: () => clock });
  const follow = (uid, index) => service({ action: 'follow', payload: { seriesId: catalog[index].id } }, { uid });
  const first = await Promise.all(Array.from({ length: 21 }, (_, index) => follow('alice', index)));
  assert.equal(first.filter((result) => result.ok).length, 20);
  assert.equal(first.filter((result) => result.error?.code === 'RATE_LIMITED').length, 1);
  assert.equal((await store.listFollows('alice')).length, 20);
  assert.equal([...store.maps.keys()].filter((key) => key.startsWith('guoman_monitor_targets/')).length, 20);
  assert.equal((await follow('bob', 20)).ok, true);
  assert.equal((await follow('alice', 20)).ok, true);
  assert.equal((await service({ action: 'submit', payload: { title: '补录', url: catalog[21].url } }, { uid: 'alice' })).error.code, 'RATE_LIMITED');
  clock = new Date('2026-10-05T16:00:00.000Z');
  assert.equal((await follow('alice', 21)).ok, true);
});

test('500-follow limit is atomic, covers submission, and releases capacity on unfollow', async () => {
  const store = new MemoryStore();
  const catalog = manySeed(502);
  for (const item of catalog) await store.put('guoman_monitor_targets', item.id, { seriesId: item.id, source: 'hot' });
  const service = createUserService({ store, seed: catalog });
  const call = (action, payload) => service({ action, payload }, { uid: 'alice' });
  for (let index = 0; index < 499; index++) assert.equal((await call('follow', { seriesId: catalog[index].id })).ok, true);
  const final = await Promise.all([call('follow', { seriesId: catalog[499].id }), call('follow', { seriesId: catalog[500].id })]);
  assert.equal(final.filter((result) => result.ok).length, 1);
  assert.equal(final.filter((result) => result.error?.code === 'FOLLOW_LIMIT').length, 1);
  assert.equal((await call('follow', { seriesId: catalog[0].id })).ok, true);
  assert.equal((await call('submit', { title: '补录新作品', url: 'https://www.bilibili.com/bangumi/play/ss999000' })).error.code, 'FOLLOW_LIMIT');
  assert.equal((await store.listFollows('alice')).length, 500);
  await call('unfollow', { seriesId: catalog[0].id });
  assert.equal((await call('follow', { seriesId: catalog[501].id })).ok, true);
  assert.equal((await store.listFollows('alice')).length, 500);
});

test('progress uses actual published episodes rather than totals, schedules, or trailers', async () => {
  const now = Date.parse('2026-10-05T00:00:00.000Z');
  const fixtures = [
    { episodes: '全24集，更新至12集', latestEpisode: undefined, events: [], maximum: 12 },
    { episodes: '预计全24集', latestEpisode: 0, events: [{ at: now - 1000, label: '第5话', published: true }], maximum: 5 },
    { episodes: '更新至2集', latestEpisode: undefined, events: [
      { at: now - 1000, label: '第4集', published: true },
      { at: now + 1000, label: '第10集', published: true },
      { at: now - 1000, label: '第11集', published: false },
      { at: now - 1000, label: '第12集', published: true, delayed: true },
      { at: now - 1000, label: '第13集预告', published: true },
      { at: now - 1000, label: '第14集花絮', published: true },
    ], maximum: 4 },
    { episodes: '24集全', status: 'finished', latestEpisode: undefined, events: [], maximum: 24 },
  ];
  for (const fixture of fixtures) {
    const service = createUserService({ store: new MemoryStore(), seed: [{ ...seed[0], ...fixture }], now: () => new Date(now) });
    const call = (action, payload) => service({ action, payload }, { uid: 'alice' });
    await call('follow', { seriesId: 'bili-seed' });
    const progress = { seriesId: 'bili-seed', currentEpisode: fixture.maximum + 1, episodeCompleted: false, paused: false, version: 1 };
    assert.equal((await call('progress', progress)).error?.code, 'INVALID_PROGRESS');
    assert.equal((await call('progress', { ...progress, currentEpisode: fixture.maximum })).ok, true);
  }
});

test('planned updates and totals are unknown until a confirmed release exists', () => {
  const now = Date.parse('2026-10-05T00:00:00.000Z');
  for (const episodes of ['预计更新至13集', '第13集预告', '预告更新至13集', '第13集预告，更新至13集', '计划更新至13集', '下周更新至13集', '全24集', '24集全']) {
    const series = { ...seed[0], episodes, latestEpisode: undefined, status: 'ongoing', events: [] };
    assert.equal(latestPublishedEpisode(series, now), null, episodes);
    series.events = [{ at: now - 1000, label: '第12话', published: true, delayed: false }];
    assert.equal(latestPublishedEpisode(series, now), 12, `${episodes}: reliable published event`);
  }
  assert.equal(latestPublishedEpisode({ ...seed[0], episodes: '全24集', latestEpisode: undefined, status: 'finished' }, now), 24);
  assert.equal(latestPublishedEpisode({ ...seed[0], episodes: '预计更新至13集', latestEpisode: 12 }, now), 12);
});


test('episode completion changes the state without requiring playback seconds', async () => {
  const { call } = setup();
  await call('alice', 'follow', { seriesId: 'bili-seed' });
  const started = await call('alice', 'progress', { seriesId: 'bili-seed', currentEpisode: 10, episodeCompleted: false, paused: false, version: 1 });
  assert.equal(started.ok, true);
  assert.equal(started.data.currentEpisode, 10);
  assert.equal(started.data.episodeCompleted, false);
  const completed = await call('alice', 'progress', { seriesId: 'bili-seed', currentEpisode: 10, episodeCompleted: true, paused: false, version: 2 });
  assert.equal(completed.ok, true);
  assert.equal(completed.data.episodeCompleted, true);
  assert.equal('positionSeconds' in completed.data, false);
});

test('legacy cloud records retain completed counts and convert partial seconds on read and write', async () => {
  const { call, store } = setup();
  await call('alice', 'follow', { seriesId: 'bili-seed' });
  const [key, follow] = [...store.maps.entries()].find(([, value]) => value.kind === 'follow');
  const { currentEpisode, episodeCompleted, ...base } = follow;
  store.maps.set(key, { ...base, watchedEpisode: 3, positionSeconds: 90 });
  let state = (await call('alice', 'library')).data.follows[0];
  assert.equal(state.currentEpisode, 4);
  assert.equal(state.episodeCompleted, false);
  assert.equal('positionSeconds' in state, false);
  await call('alice', 'open', { seriesId: 'bili-seed' });
  assert.equal('positionSeconds' in store.maps.get(key), false);
  store.maps.set(key, { ...base, watchedEpisode: 3, positionSeconds: 0 });
  state = (await call('alice', 'library')).data.follows[0];
  assert.equal(state.currentEpisode, 3);
  assert.equal(state.episodeCompleted, true);
});
