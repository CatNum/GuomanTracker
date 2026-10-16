import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createUserService as createDatabaseUserService } from '../shared/user-service.mjs';
import { createCloudbaseStore } from '../shared/cloudbase-store.mjs';
import { latestPublishedEpisode } from '../shared/published-episode.mjs';
import { CommitUnconfirmedError } from '../shared/pg-store.mjs';
import { normalizeOfficialUrl } from '../shared/official-links.mjs';
import { resolveOfficialMetadata } from '../shared/submission-metadata.mjs';

test('SCF CommonJS entry exposes its callable index.main without loading network dependencies', () => {
  const require = createRequire(import.meta.url);
  assert.equal(typeof require('../functions/guoman-user/index.js').main, 'function');
});

// This boundary implementation provides isolated, atomic document transactions.
// The service itself makes every ownership, quota, and progress decision.
class MemoryStore {
  maps = new Map();
  queue = Promise.resolve();
  lastTransactionWrites = [];
  async get(collection, id) { return structuredClone(this.maps.get(`${collection}/${id}`) ?? null); }
  async put(collection, id, data) { this.maps.set(`${collection}/${id}`, structuredClone(data)); }
  async remove(collection, id) { this.maps.delete(`${collection}/${id}`); }
  async findSeriesByUrl(url) { return [...this.maps.entries()].filter(([key]) => key.startsWith('guoman_series/')).map(([,value]) => structuredClone(value)).find(item => item.url === url) ?? null; }
  async listFollows(owner) {
    return [...this.maps.entries()].filter(([key, value]) => key.startsWith('guoman_watch_state/') && value.owner === owner && value.kind === 'follow').map(([, value]) => structuredClone(value));
  }
  transaction(callback) {
    const result = this.queue.then(async () => {
      const before = structuredClone(this.maps);
      const writes = [];
      const tx = {
        get: (...args) => this.get(...args),
        put: async (...args) => { writes.push({ operation: 'put', collection: args[0], id: args[1] }); return this.put(...args); },
        remove: async (...args) => { writes.push({ operation: 'remove', collection: args[0], id: args[1] }); return this.remove(...args); },
      };
      try {
        const value = await callback(tx);
        this.lastTransactionWrites = writes;
        return value;
      } catch (error) { this.maps = before; throw error; }
    });
    this.queue = result.catch(() => {});
    return result;
  }
}

function createTestService({ seed = [], ...options }) {
  for (const item of seed) if (options.store.maps && !options.store.maps.has('guoman_series/' + item.id))
    options.store.maps.set('guoman_series/' + item.id, structuredClone(item));
  return createDatabaseUserService(options);
}

function accountStats(store, uid = 'alice') {
  return [...store.maps.values()].find((value) => value.kind === 'stats' && value.owner === uid) ?? null;
}

const seed = [{ id: 'bili-seed', title: '已收录国漫', platform: 'bilibili', url: 'https://www.bilibili.com/bangumi/play/ss123', cover: '', status: '连载', episodes: '更新至10话', events: [], checkedAt: '2026-10-05T00:00:00.000Z', source: '官方目录', latestEpisode: 10 }];
function setup(start = '2026-10-05T00:00:00.000Z') {
  const store = new MemoryStore();
  let clock = new Date(start);
  const service = createTestService({ store, seed, now: () => clock, resolveMetadata: async () => ({ title: '官方测试节目' }) });
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

test('official-link-only submissions preserve known titles and save resolved titles for new shows', async () => {
  const { call } = setup();
  const known = await call('alice', 'submit', { url: seed[0].url });
  assert.equal(known.data.series.title, '已收录国漫');
  const fresh = await call('alice', 'submit', { url: 'https://www.bilibili.com/bangumi/play/ss456' });
  assert.equal(fresh.data.series.title, '官方测试节目');
  assert.equal(fresh.data.series.metadataPending, false);
  assert.equal(fresh.data.series.episodes, '待核验');
  assert.equal(fresh.data.series.monitoring, 'queued');
});

test('new submissions resolve official metadata once before the transaction while existing titles win races', async () => {
  const store = new MemoryStore();
  const order = [];
  let calls = 0;
  const service = createTestService({
    store,
    seed,
    resolveMetadata: async (official) => {
      calls++;
      order.push('metadata');
      assert.equal(official.platform, 'bilibili');
      await store.put('guoman_series', official.id, { id: official.id, title: '并发已收录标题', platform: official.platform, url: official.url, cover: '', status: 'unknown', episodes: '待核验', events: [], checkedAt: '2026-10-05T00:00:00.000Z' });
      return { title: '抓取到的标题', cover: 'https://img.example/cover.jpg' };
    },
  });
  const originalTransaction = store.transaction.bind(store);
  store.transaction = (callback) => { order.push('transaction'); return originalTransaction(callback); };
  const call = (action, payload = {}) => service({ action, payload }, { uid: 'alice' });
  const fresh = await call('submit', { url: 'https://www.bilibili.com/bangumi/play/ss456' });
  assert.equal(fresh.data.series.title, '并发已收录标题');
  assert.equal(calls, 1);
  assert.deepEqual(order, ['metadata', 'transaction']);
  const known = await call('submit', { url: seed[0].url });
  assert.equal(known.data.series.title, '已收录国漫');
  assert.equal(calls, 1);
});

test('daily submit, follow, and monitor quotas reject new links before metadata resolution', async () => {
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  let calls = 0;
  const dailyStore = new MemoryStore();
  const dailyService = createTestService({ store: dailyStore, seed, resolveMetadata: async () => { calls++; return { title: '真实标题' }; } });
  const dailyCall = (payload) => dailyService({ action: 'submit', payload }, { uid: 'alice' });
  for (let index = 0; index < 10; index++) {
    const result = await dailyCall({ url: `https://www.bilibili.com/bangumi/play/ss${7654000 + index}` });
    assert.equal(result.ok, true);
  }
  assert.equal(calls, 10);
  const dailyBlocked = await dailyCall({ url: 'https://www.bilibili.com/bangumi/play/ss7654999' });
  assert.equal(dailyBlocked.error.code, 'RATE_LIMITED');
  assert.equal(calls, 10);

  let followCalls = 0;
  const followStore = new MemoryStore();
  await followStore.put('guoman_watch_state', `stats-${sha('alice')}`, { kind: 'stats', owner: 'alice', followCount: '500', priorityOrder: [], membershipVersion: 500, orderVersion: 0 });
  for (let index = 0; index < 500; index++) {
    await followStore.put('guoman_watch_state', `legacy-follow-${index}`, { kind: 'follow', owner: 'alice', seriesId: `legacy-${index}` });
  }
  const followService = createTestService({ store: followStore, seed, resolveMetadata: async () => { followCalls++; return { title: '真实标题' }; } });
  const followBlocked = await followService({ action: 'submit', payload: { url: 'https://www.bilibili.com/bangumi/play/ss7655000' } }, { uid: 'alice' });
  assert.equal(followBlocked.error.code, 'FOLLOW_LIMIT');
  assert.equal(followCalls, 0);

  let monitorCalls = 0;
  const monitorStore = new MemoryStore();
  const day = new Date('2026-10-05T00:00:00.000Z').getTime() + 8 * 3600000;
  const chinaDay = new Date(day).toISOString().slice(0, 10);
  await monitorStore.put('guoman_watch_state', `scan-quota-${sha(JSON.stringify(['alice', chinaDay]))}`, { kind: 'scan-quota', owner: 'alice', day: chinaDay, count: 20 });
  const monitorService = createTestService({ store: monitorStore, seed, now: () => new Date('2026-10-05T00:00:00.000Z'), resolveMetadata: async () => { monitorCalls++; return { title: '真实标题' }; } });
  const monitorBlocked = await monitorService({ action: 'submit', payload: { url: 'https://www.bilibili.com/bangumi/play/ss7655001' } }, { uid: 'alice' });
  assert.equal(monitorBlocked.error.code, 'RATE_LIMITED');
  assert.equal(monitorCalls, 0);
});

test('metadata resolution failure writes nothing and a later successful retry saves once', async () => {
  const store = new MemoryStore();
  let available = false;
  const service = createTestService({ store, seed, resolveMetadata: async () => {
    if (!available) throw new Error('PRIVATE_TIMEOUT_DETAIL');
    return { title: '官方节目名称' };
  } });
  const call = (action, payload) => service({ action, payload }, { uid: 'alice' });
  const url = 'https://www.bilibili.com/bangumi/play/ss457';
  const failed = await call('submit', { url });
  assert.deepEqual(failed, { ok: false, error: { code: 'METADATA_UNAVAILABLE', message: '补录失败：未能识别官方节目名称，本次未保存任何更改。请稍后重试或使用该节目的其他官方链接。' } });
  assert.equal(store.maps.size, seed.length);
  available = true;
  const repeated = await call('submit', { url });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.data.series.title, '官方节目名称');
  assert.equal(repeated.data.series.metadataPending, false);
  assert.equal((await store.listFollows('alice')).length, 1);
  assert.equal([...store.maps.values()].find(value => value.kind === 'quota').count, 1);
  assert.equal([...store.maps.values()].find(value => value.kind === 'scan-quota').count, 1);
});

test('all supported platforms reject unrecognized official responses without writes', async (t) => {
  const cases = [
    ['bilibili', 'https://www.bilibili.com/bangumi/play/ss457', '{"code":-404}', 'application/json'],
    ['tencent', 'https://v.qq.com/x/cover/mcv8hkc8zk8lnov/x0036x5qqsr.html', '{"ret":0,"data":{"CardList":[]}}', 'application/json'],
    ['youku', 'https://v.youku.com/v_show/id_XMzEyMzQ1.html', '<title>优酷</title>', 'text/html'],
  ];
  for (const [platform, url, body, contentType] of cases) await t.test(platform, async () => {
    const store = new MemoryStore();
    const service = createTestService({ store, resolveMetadata: official => resolveOfficialMetadata(official, {
      fetcher: async () => new Response(body, { headers: { 'content-type': contentType } }),
    }) });
    const result = await service({ action: 'submit', payload: { url, title: '用户自填名称不能替代官方识别' } }, { uid: 'alice' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'METADATA_UNAVAILABLE');
    assert.equal(store.maps.size, 0);
  });
});

test('all supported platforms save only resolved official titles while episode verification stays separate', async (t) => {
  const cases = [
    ['bilibili', 'https://www.bilibili.com/bangumi/play/ss457', '{"code":0,"result":{"title":"官方国创","episodes":[]}}', 'application/json', '官方国创'],
    ['tencent', 'https://v.qq.com/x/cover/mcv8hkc8zk8lnov.html', JSON.stringify({ ret: 0, data: { CardList: [{ type: 'pc_introduction', children_list: { 0: { cards: [{ params: { title: '完美世界', 'report.cid': 'mcv8hkc8zk8lnov' } }] } } }] } }), 'application/json', '完美世界'],
    ['youku', 'https://v.youku.com/v_show/id_XMzEyMzQ1.html', '<title>师兄啊师兄_优酷</title>', 'text/html', '师兄啊师兄'],
  ];
  for (const [platform, url, body, contentType, title] of cases) await t.test(platform, async () => {
    const store = new MemoryStore();
    const service = createTestService({ store, resolveMetadata: official => resolveOfficialMetadata(official, {
      fetcher: async () => new Response(body, { headers: { 'content-type': contentType } }),
    }) });
    const result = await service({ action: 'submit', payload: { url } }, { uid: 'alice' });
    assert.equal(result.ok, true);
    assert.equal(result.data.series.title, title);
    assert.equal(result.data.series.metadataPending, false);
    assert.equal(result.data.series.episodes, '待核验');
    assert.equal((await store.listFollows('alice')).length, 1);
  });
});

test('missing resolver and empty metadata cannot create a submission', async (t) => {
  for (const metadata of [undefined, null, {}, { title: '' }, { title: '   ' }]) await t.test(JSON.stringify(metadata) ?? 'missing resolver', async () => {
    const store = new MemoryStore();
    const service = createTestService({ store, ...(metadata === undefined ? {} : { resolveMetadata: async () => metadata }) });
    const result = await service({ action: 'submit', payload: { url: 'https://www.bilibili.com/bangumi/play/ss457' } }, { uid: 'alice' });
    assert.equal(result.error?.code, 'METADATA_UNAVAILABLE');
    assert.equal(store.maps.size, 0);
  });
});

test('legacy pending submissions are retried and only repaired when official resolution succeeds', async () => {
  const store = new MemoryStore();
  const official = normalizeOfficialUrl('https://v.qq.com/x/cover/mcv8hkc8zk8lnov.html');
  const legacy = { ...seed[0], id: official.id, url: official.url, platform: 'tencent', title: '腾讯视频待核验节目 mcv8hkc8zk8lnov', metadataPending: true };
  await store.put('guoman_series', official.id, legacy);
  let available = false;
  const service = createTestService({ store, resolveMetadata: async () => available ? { title: '完美世界', cover: 'https://img.example.test/cover.jpg' } : null });
  const call = () => service({ action: 'submit', payload: { url: official.url } }, { uid: 'alice' });
  const before = structuredClone(store.maps);
  assert.equal((await call()).error?.code, 'METADATA_UNAVAILABLE');
  assert.deepEqual(store.maps, before);
  available = true;
  const result = await call();
  assert.equal(result.ok, true);
  assert.equal(result.data.series.title, '完美世界');
  assert.equal(result.data.series.metadataPending, false);
  assert.equal((await store.get('guoman_series', official.id)).title, '完美世界');
  assert.equal((await store.listFollows('alice')).length, 1);
});

test('retrying an already followed pending record preserves progress and quotas on failure and repair', async () => {
  const { call, store } = setup();
  const url = 'https://www.bilibili.com/bangumi/play/ss456';
  const added = await call('alice', 'submit', { url });
  const id = added.data.series.id;
  const legacy = { ...added.data.series, title: 'B站待核验节目 ss456', metadataPending: true };
  await store.put('guoman_series', id, legacy);
  let available = false;
  const service = createTestService({ store, resolveMetadata: async () => available ? { title: '识别后的官方名称' } : null });
  const retry = () => service({ action: 'submit', payload: { url } }, { uid: 'alice' });
  const before = structuredClone(store.maps);
  assert.equal((await retry()).error?.code, 'METADATA_UNAVAILABLE');
  assert.deepEqual(store.maps, before);
  available = true;
  assert.equal((await retry()).data.series.title, '识别后的官方名称');
  assert.deepEqual(await store.listFollows('alice'), [ { ...added.data.follow, owner: 'alice', kind: 'follow' } ]);
  for (const [key, value] of before) if (!key.startsWith('guoman_series/')) assert.deepEqual(store.maps.get(key), value);
});

test('a title becoming pending during submission is rejected at the transaction boundary without writes', async () => {
  const store = new MemoryStore();
  const official = normalizeOfficialUrl('https://www.bilibili.com/bangumi/play/ss457');
  const confirmed = { ...seed[0], id: official.id, url: official.url };
  await store.put('guoman_series', official.id, confirmed);
  const transaction = store.transaction.bind(store);
  store.transaction = async callback => {
    await store.put('guoman_series', official.id, { ...confirmed, metadataPending: true });
    return transaction(callback);
  };
  const service = createTestService({ store });
  const result = await service({ action: 'submit', payload: { url: official.url } }, { uid: 'alice' });
  assert.equal(result.error?.code, 'METADATA_UNAVAILABLE');
  assert.equal(store.maps.size, 1);
  assert.equal((await store.listFollows('alice')).length, 0);
});

test('membership stats preserve unknown fields and increment only on real follow changes', async () => {
  const store = new MemoryStore();
  const catalog = [...seed, { ...seed[0], id: 'bili-next', url: 'https://www.bilibili.com/bangumi/play/ss124' }];
  const service = createTestService({ store, seed: catalog });
  const call = (action, payload = {}) => service({ action, payload }, { uid: 'alice' });
  await call('follow', { seriesId: 'bili-seed' });
  let stats = accountStats(store);
  assert.deepEqual(stats.priorityOrder, ['bili-seed']);
  assert.equal(stats.membershipVersion, 1);
  assert.equal(stats.orderVersion, 0);
  await store.put('guoman_watch_state', [...store.maps.keys()].find((key) => key.startsWith('guoman_watch_state/stats-')).split('/')[1], { ...stats, preserved: 'yes' });
  await call('follow', { seriesId: 'bili-next' });
  stats = accountStats(store);
  assert.equal(stats.preserved, 'yes');
  assert.deepEqual(stats.priorityOrder, ['bili-seed', 'bili-next']);
  assert.equal(stats.membershipVersion, 2);
  assert.equal((await call('progress', { seriesId: 'bili-seed', currentEpisode: 1, episodeCompleted: false, paused: false, version: 1 })).ok, true);
  assert.equal(accountStats(store).membershipVersion, 2);
  assert.equal((await call('unfollow', { seriesId: 'bili-next' })).ok, true);
  stats = accountStats(store);
  assert.deepEqual(stats.priorityOrder, ['bili-seed']);
  assert.equal(stats.membershipVersion, 3);
  assert.equal(stats.orderVersion, 0);
  assert.equal(stats.preserved, 'yes');
});

test('legacy follows without account stats keep title order and rebuild the count before adding a new link', async () => {
  const { store, call } = setup();
  for (const [id, title] of [['old-yuan', '苍元图'], ['old-lan', '苍兰诀']]) {
    await store.put('guoman_series', id, { id, title, platform: 'bilibili', url: `https://www.bilibili.com/bangumi/play/${id}`, cover: '', status: 'unknown', episodes: '待核验', events: [], checkedAt: '2026-10-05T00:00:00.000Z', source: 'test' });
    await store.put('guoman_watch_state', `legacy-${id}`, { owner: 'alice', kind: 'follow', seriesId: id, currentEpisode: 0, episodeCompleted: false, paused: false, updatedAt: '2026-10-05T00:00:00.000Z', version: 1 });
  }
  const added = await call('alice', 'submit', { url: 'https://www.bilibili.com/bangumi/play/ss7654321' });
  assert.equal(added.ok, true);
  const stats = accountStats(store);
  assert.equal(stats.followCount, 3);
  assert.deepEqual(stats.priorityOrder, ['old-lan', 'old-yuan', added.data.series.id]);
});

test('library returns a snapshot-consistent full order and retries membership changes during list', async () => {
  const store = new MemoryStore();
  const service = createTestService({ store, seed });
  await service({ action: 'follow', payload: { seriesId: 'bili-seed' } }, { uid: 'alice' });
  const statsKey = [...store.maps.keys()].find((key) => key.startsWith('guoman_watch_state/stats-'));
  const originalList = store.listFollows.bind(store);
  let listCalls = 0;
  store.listFollows = async (uid) => {
    const records = await originalList(uid);
    listCalls++;
    if (listCalls === 1) await store.put('guoman_watch_state', statsKey.split('/')[1], { ...accountStats(store), membershipVersion: 2 });
    return records;
  };
  const result = await service({ action: 'library' }, { uid: 'alice' });
  assert.equal(result.ok, true);
  assert.equal(listCalls, 2);
  assert.deepEqual(result.data.priorityOrder, ['bili-seed']);
  assert.equal(result.data.membershipVersion, 2);
  assert.equal(result.data.orderVersion, 0);
});

test('reorder updates one stats document for 500 follows and rejects malformed or stale orders', async () => {
  const store = new MemoryStore();
  const catalog = manySeed(500);
  const service = createTestService({ store, seed: catalog });
  const follows = catalog.map((series) => ({ owner: 'alice', kind: 'follow', seriesId: series.id, currentEpisode: 0, episodeCompleted: false, paused: false, updatedAt: '2026-10-05T00:00:00.000Z', version: 1 }));
  assert.equal((await service({ action: 'follow', payload: { seriesId: catalog[0].id } }, { uid: 'alice' })).ok, true);
  for (const follow of follows.slice(1)) await store.put('guoman_watch_state', `follow-${follow.seriesId}`, follow);
  const statsKey = [...store.maps.keys()].find((key) => key.startsWith('guoman_watch_state/stats-'));
  await store.put('guoman_watch_state', statsKey.split('/')[1], { ...accountStats(store), followCount: 500, priorityOrder: follows.map((item) => item.seriesId), membershipVersion: 5, orderVersion: 3, retained: true });
  const call = (payload) => service({ action: 'reorder', payload }, { uid: 'alice' });
  const reversed = follows.map((item) => item.seriesId).reverse();
  assert.equal((await call({ seriesIds: reversed.slice(1), expectedMembershipVersion: 5, expectedOrderVersion: 3 })).error.code, 'INVALID_ORDER');
  assert.equal((await call({ seriesIds: [...reversed, reversed[0]], expectedMembershipVersion: 5, expectedOrderVersion: 3 })).error.code, 'INVALID_ORDER');
  assert.equal((await call({ seriesIds: [...reversed.slice(1), 'somebody-elses-id'], expectedMembershipVersion: 5, expectedOrderVersion: 3 })).error.code, 'INVALID_ORDER');
  const saved = await call({ seriesIds: reversed, expectedMembershipVersion: 5, expectedOrderVersion: 3 });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.data.priorityOrder, reversed);
  assert.equal(saved.data.orderVersion, 4);
  assert.equal(saved.data.membershipVersion, 5);
  assert.equal(accountStats(store).retained, true);
  assert.equal(store.lastTransactionWrites.length, 1);
  assert.equal(store.lastTransactionWrites[0].id, statsKey.split('/')[1]);
  assert.equal((await call({ seriesIds: reversed, expectedMembershipVersion: 5, expectedOrderVersion: 3 })).error.code, 'CONFLICT');
});

test('reorder detects membership ABA and concurrent order changes but ignores progress versions', async () => {
  const { call: baseCall, store } = setup();
  await baseCall('alice', 'follow', { seriesId: 'bili-seed' });
  const invoke = (action, payload = {}) => baseCall('alice', action, payload);
  const statsKey = [...store.maps.keys()].find((key) => key.startsWith('guoman_watch_state/stats-'));
  const current = accountStats(store);
  const orderPayload = { seriesIds: ['bili-seed'], expectedMembershipVersion: current.membershipVersion, expectedOrderVersion: current.orderVersion };
  const originalList = store.listFollows.bind(store);
  let alter = true;
  store.listFollows = async (uid) => {
    if (alter && uid === 'alice') {
      alter = false;
      await invoke('unfollow', { seriesId: 'bili-seed' });
      await invoke('follow', { seriesId: 'bili-seed' });
    }
    return originalList(uid);
  };
  assert.equal((await invoke('reorder', orderPayload)).error.code, 'CONFLICT');
  store.listFollows = originalList;
  const latest = accountStats(store);
  const firstOrder = { seriesIds: ['bili-seed'], expectedMembershipVersion: latest.membershipVersion, expectedOrderVersion: latest.orderVersion };
  const concurrent = await Promise.all([invoke('reorder', firstOrder), invoke('reorder', firstOrder)]);
  assert.equal(concurrent.filter((result) => result.ok).length, 1);
  assert.equal(concurrent.filter((result) => result.error?.code === 'CONFLICT').length, 1);
  const changed = accountStats(store);
  const savedAfterProgress = await invoke('progress', { seriesId: 'bili-seed', currentEpisode: 2, episodeCompleted: false, paused: false, version: 1 });
  assert.equal(savedAfterProgress.ok, true);
  assert.equal((await invoke('reorder', { seriesIds: ['bili-seed'], expectedMembershipVersion: changed.membershipVersion, expectedOrderVersion: changed.orderVersion })).ok, true);
  assert.equal(accountStats(store).membershipVersion, changed.membershipVersion);
});

test('unsupported platforms reject submit, follow, progress, and open while unfollow remains available', async () => {
  const iqiyi = { id: 'iqiyi-seed', title: '旧平台节目', platform: 'iqiyi', url: 'https://www.iqiyi.com/a_abc.html' };
  const { call, store } = setup();
  const service = createTestService({ store, seed: [...seed, iqiyi] });
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
  assert.equal([...store.maps.keys()].filter((key) => key.startsWith('guoman_series/')).length, 11);
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
  const service = createTestService({ store: { listFollows: async () => { throw new Error('SECRET_INTERNAL'); } }, seed });
  const result = await service({ action: 'library' }, { uid: 'alice' });
  assert.equal(result.error.code, 'SERVICE_UNAVAILABLE');
  assert.ok(!JSON.stringify(result).includes('SECRET_INTERNAL'));
});

test('uncertain PG commit returns a distinct refresh-required envelope without leaking its cause', async () => {
  const store = {
    get: async () => null,
    listFollows: async () => [],
    transaction: async () => { throw new CommitUnconfirmedError(new Error('PRIVATE_NETWORK_DETAIL')); },
  };
  const service = createTestService({ store, seed });
  const result = await service({ action: 'unfollow', payload: { seriesId: 'bili-seed' } }, { uid: 'alice' });
  assert.deepEqual(result, {
    ok: false,
    error: { code: 'TX_OUTCOME_UNKNOWN', message: '保存结果未确认，请刷新记录' },
  });
  assert.ok(!JSON.stringify(result).includes('PRIVATE_NETWORK_DETAIL'));
});

test('CloudBase anonymous identities with a uid are rejected', async () => {
  const service = createTestService({ store: new MemoryStore(), seed });
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
  const service = createTestService({ store, seed: catalog, now: () => clock });
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
  const service = createTestService({ store, seed: catalog });
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
    const service = createTestService({ store: new MemoryStore(), seed: [{ ...seed[0], ...fixture }], now: () => new Date(now) });
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


test('membership writes return committed versions and order without an extra library read', async () => {
  const { call } = setup();
  const added = await call('alice', 'follow', { seriesId: 'bili-seed' });
  assert.deepEqual(added.data.libraryPatch, {
    beforeMembershipVersion: 0, beforeOrderVersion: 0,
    membershipVersion: 1, orderVersion: 0, priorityOrder: ['bili-seed'],
  });
  assert.equal(added.data.series.id, 'bili-seed');
  const repeated = await call('alice', 'follow', { seriesId: 'bili-seed' });
  assert.equal(repeated.data.libraryPatch.beforeMembershipVersion, 1);
  assert.equal(repeated.data.libraryPatch.membershipVersion, 1);
  const removed = await call('alice', 'unfollow', { seriesId: 'bili-seed' });
  assert.deepEqual(removed.data.libraryPatch, {
    beforeMembershipVersion: 1, beforeOrderVersion: 0,
    membershipVersion: 2, orderVersion: 0, priorityOrder: [],
  });
  assert.deepEqual((await call('alice', 'library')).data.follows, []);
});

test('following starts independent transaction reads together instead of waiting on each network hop', async () => {
  const { call, store } = setup();
  await call('alice', 'follow', { seriesId: 'bili-seed' });
  const originalGet = store.get.bind(store);
  const waiting = [];
  let released = false;
  store.get = async (...args) => {
    if (!released) await new Promise(resolve => waiting.push(resolve));
    return originalGet(...args);
  };
  const pending = call('alice', 'follow', { seriesId: 'bili-seed' });
  await new Promise(resolve => setImmediate(resolve));
  const simultaneousReads = waiting.length;
  released = true;
  waiting.forEach(resolve => resolve());
  assert.equal((await pending).ok, true);
  assert.equal(simultaneousReads, 5);
});


test('an absent PG program cannot be followed using a file fallback', async () => {
  const service = createDatabaseUserService({ store: new MemoryStore(), seed });
  assert.equal((await service({ action: 'follow', payload: { seriesId: 'bili-seed' } }, { uid: 'alice' })).error?.code, 'NOT_FOUND');
});
test('PG program updates become the personal library source without rebuilding', async () => {
  const { store, call } = setup();
  await call('alice', 'follow', { seriesId: 'bili-seed' });
  const old = await store.get('guoman_series', 'bili-seed');
  await store.put('guoman_series', 'bili-seed', { ...old, latestEpisode: 15, episodes: '更新至15集' });
  assert.equal((await call('alice', 'library')).data.series[0].latestEpisode, 15);
});
