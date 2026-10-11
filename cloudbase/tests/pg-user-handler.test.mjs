import test from 'node:test';
import assert from 'node:assert/strict';
import { createPgUserHandler } from '../shared/pg-user-handler.mjs';

function rpc(value) {
  return { Columns: ['result'], Rows: [JSON.stringify([JSON.stringify(value)])] };
}

test('trusted anonymous identity is rejected before manager construction or SQL', async () => {
  let managers = 0;
  const handle = createPgUserHandler({
    app: { auth: () => ({ getUserInfo: () => ({ uid: 'anonymous-uid', isAnonymous: true }) }) },
    createManager: () => { managers++; throw new Error('must not run'); },
    loadSeed: async () => [],
  });
  assert.deepEqual(await handle({ action: 'library', uid: 'forged-user' }), {
    ok: false, error: { code: 'UNAUTHENTICATED', message: '请先登录账号。' },
  });
  assert.equal(managers, 0);
});

test('each authenticated request creates its own manager and uses only trusted uid', async () => {
  let uid = 'alice';
  let seedLoads = 0;
  let managers = 0;
  const owners = [];
  const handle = createPgUserHandler({
    app: { auth: () => ({ getUserInfo: () => ({ uid, isAnonymous: false }) }) },
    createManager: () => {
      managers++;
      return { database: { executePGSql: async ({ Sql }) => {
        const hex = /decode\('([0-9a-f]+)', 'hex'\)/.exec(Sql)?.[1];
        assert.ok(hex);
        const args = JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
        assert.match(Sql, /^SELECT guoman_private\.list_follows_page\(/);
        owners.push(args.owner);
        return rpc({ documents: [], related: [], next_after: '' });
      } } };
    },
    loadSeed: async () => { seedLoads++; return []; },
  });
  assert.equal((await handle({ action: 'library', uid: 'forged' })).ok, true);
  uid = 'bob';
  assert.equal((await handle({ action: 'library', uid: 'forged' })).ok, true);
  assert.deepEqual(owners, ['alice', 'bob']);
  assert.equal(managers, 2);
  assert.equal(seedLoads, 1);
});
