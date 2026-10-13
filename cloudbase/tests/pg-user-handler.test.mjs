import test from 'node:test';
import assert from 'node:assert/strict';
import { createPgUserHandler } from '../shared/pg-user-handler.mjs';

function rpc(value) {
  return { Columns: ['result'], Rows: [JSON.stringify([JSON.stringify(value)])] };
}
const parseContext = (context) => context.environment
  ? { environment: JSON.parse(context.environment) }
  : { environ: Object.fromEntries(context.environ.split(';').filter(Boolean).map((item) => item.split('='))) };
const contextFor = (uid, flag = 'false') => ({ environment: JSON.stringify({ TCB_UUID: uid, TCB_ISANONYMOUS_USER: flag }) });

test('one handler accepts A then rejects missing, empty and anonymous contexts before serving B', async () => {
  let managers = 0;
  let profiles = 0;
  let seedLoads = 0;
  const owners = [];
  const previousUid = process.env.TCB_UUID;
  const previousFlag = process.env.TCB_ISANONYMOUS_USER;
  process.env.TCB_UUID = 'stale-alice';
  process.env.TCB_ISANONYMOUS_USER = 'false';
  try {
    const handle = createPgUserHandler({
      app: { auth: () => ({
        getUserInfo: () => { throw new Error('SDK merged identity must not be used'); },
        getEndUserInfo: async () => { profiles++; throw new Error('Optional profile service is unavailable'); },
      }) },
      parseContext,
      createManager: () => {
        managers++;
        return { database: { executePGSql: async ({ Sql }) => {
          const hex = /decode\('([0-9a-f]+)', 'hex'\)/.exec(Sql)?.[1];
          assert.ok(hex);
          const args = JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
          if (Sql.includes('get_document')) return rpc({ exists: false });
          assert.match(Sql, /^SELECT guoman_private\.list_follows_page\(/);
          owners.push(args.owner);
          return rpc({ documents: [], related: [], next_after: '' });
        } } };
      },
      loadSeed: async () => { seedLoads++; return []; },
    });
    const forged = { action: 'library', uid: 'forged', owner: 'forged', TCB_UUID: 'forged', context: contextFor('forged') };
    assert.equal((await handle(forged, contextFor('alice'))).ok, true);
    for (const context of [undefined, {}, contextFor('anonymous', 'true')]) {
      assert.equal((await handle(forged, context)).error.code, 'UNAUTHENTICATED');
      assert.equal(managers, 1);
      assert.equal(profiles, 0);
    }
    assert.equal((await handle(forged, contextFor('bob'))).ok, true);
    assert.deepEqual(owners, ['alice', 'bob']);
    assert.equal(managers, 2);
    assert.equal(profiles, 0);
    assert.equal(seedLoads, 1);
  } finally {
    if (previousUid === undefined) delete process.env.TCB_UUID;
    else process.env.TCB_UUID = previousUid;
    if (previousFlag === undefined) delete process.env.TCB_ISANONYMOUS_USER;
    else process.env.TCB_ISANONYMOUS_USER = previousFlag;
  }
});

test('getCatalog requires trusted non-anonymous identity and never constructs the PG manager', async () => {
  let managers = 0;
  let reads = 0;
  const handle = createPgUserHandler({
    app: { auth: () => ({}) }, parseContext,
    createManager: () => { managers++; throw new Error('PG must not be constructed'); },
    loadSeed: async () => [], getCatalog: async () => { reads++; return { items: [{ id: 'public' }], live: true }; },
  });
  for (const context of [undefined, {}, contextFor('anonymous', 'true')]) {
    assert.equal((await handle({ action: 'getCatalog', payload: {} }, context)).error.code, 'UNAUTHENTICATED');
  }
  assert.equal((await handle({ action: 'getCatalog', payload: { uid: 'forged' } }, contextFor('alice'))).error.code, 'INVALID_REQUEST');
  assert.deepEqual(await handle({ action: 'getCatalog', payload: {} }, contextFor('alice')),
    { ok: true, data: { items: [{ id: 'public' }], live: true } });
  assert.equal(reads, 1);
  assert.equal(managers, 0);
});

test('resolveEpisode validates input and identity without loading the database or catalog', async () => {
  let resolves = 0;
  const handle = createPgUserHandler({
    parseContext,
    createManager: () => { throw new Error('episode lookup must not access PG'); },
    loadSeed: async () => { throw new Error('episode lookup must not load the seed'); },
    resolveEpisode: async (url, episode) => {
      resolves++;
      assert.equal(url, 'https://www.bilibili.com/bangumi/play/ss28747');
      assert.equal(episode, 1);
      return { episode: 1, url: 'https://www.bilibili.com/bangumi/play/ep733316' };
    },
  });
  const payload = { url: 'https://www.bilibili.com/bangumi/play/ss28747', episode: 1 };
  for (const context of [undefined, {}, contextFor('anonymous', 'true')]) {
    assert.equal((await handle({ action: 'resolveEpisode', payload }, context)).error.code, 'UNAUTHENTICATED');
  }
  for (const invalid of [null, [], {}, { ...payload, episode: 0 }, { ...payload, episode: '1' }, { ...payload, owner: 'forged' }]) {
    assert.equal((await handle({ action: 'resolveEpisode', payload: invalid }, contextFor('alice'))).error.code, 'INVALID_REQUEST');
  }
  assert.deepEqual(await handle({ action: 'resolveEpisode', payload }, contextFor('alice')), { ok: true, data: { episode: 1, url: 'https://www.bilibili.com/bangumi/play/ep733316' } });
  assert.equal(resolves, 1);
});

test('resolveEpisode returns a safe unavailable result for upstream failures', async () => {
  const handle = createPgUserHandler({
    parseContext,
    resolveEpisode: async () => { throw new Error('private upstream response'); },
  });
  const result = await handle({ action: 'resolveEpisode', payload: { url: 'https://www.bilibili.com/bangumi/play/ss28747', episode: 1 } }, contextFor('alice'));
  assert.equal(result.error.code, 'EPISODE_UNAVAILABLE');
  assert.doesNotMatch(result.error.message, /private/);
});
