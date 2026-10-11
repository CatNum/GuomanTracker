import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagementTransport } from '../shared/pg-management-transport.mjs';
import { createPgStore, CommitUnconfirmedError } from '../shared/pg-store.mjs';

function rpc(value) {
  return { Columns: ['result'], Rows: [JSON.stringify([JSON.stringify(value)])] };
}

function manager(reply) {
  const calls = [];
  return {
    calls,
    database: {
      async executePGSql({ Sql }) {
        calls.push(Sql);
        const match = /^SELECT guoman_private\.(get_document|list_follows_page|commit_documents)\(pg_catalog\.convert_from\(pg_catalog\.decode\('([0-9a-f]+)', 'hex'\), 'UTF8'\)::jsonb\) AS result$/.exec(Sql);
        assert.ok(match, 'only a fixed private function and hex-encoded JSON may reach SQL');
        return reply(match[1], JSON.parse(Buffer.from(match[2], 'hex').toString('utf8')));
      },
    },
  };
}

const follow = (id, owner = 'alice') => ({ _id: id, owner, kind: 'follow', seriesId: `series-${id}` });
const related = (documents) => documents.map((document) => ({ id: document.seriesId, exists: true, document: { _id: document.seriesId, id: document.seriesId, title: document.seriesId } }));

test('point read uses fixed private SQL and hex encoding, never interpolating caller text', async () => {
  const dangerousId = "x'); DROP TABLE users; --";
  const backend = manager((functionName, payload) => {
    assert.equal(functionName, 'get_document');
    assert.deepEqual(payload, { collection: 'guoman_series', id: dangerousId });
    return rpc({ exists: false });
  });
  const transport = createManagementTransport(backend);
  assert.deepEqual(await transport.read('guoman_series', dangerousId), { exists: false });
  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0].includes('DROP TABLE'), false);
  await assert.rejects(() => transport.read('other', 'id'), /集合/);
  assert.equal(backend.calls.length, 1);
});

test('list pages 101 follows, validates ownership and preloads related series only for this request', async () => {
  const records = Array.from({ length: 101 }, (_, index) => follow(`f-${String(index).padStart(3, '0')}`));
  const backend = manager((functionName, payload) => {
    if (functionName === 'list_follows_page') {
      const page = records.filter((item) => item._id > payload.after).slice(0, 100);
      return rpc({ documents: page, related: related(page), next_after: page.length === 100 ? page.at(-1)._id : '' });
    }
    if (functionName === 'get_document') return rpc({ exists: true, document: { _id: payload.id, id: payload.id, title: 'newer' } });
    throw new Error('unexpected function');
  });
  const library = createManagementTransport(backend, { libraryMode: true });
  const listed = await library.list('guoman_watch_state', { owner: 'alice', kind: 'follow' });
  assert.equal(listed.length, 101);
  assert.equal(backend.calls.length, 2);
  assert.deepEqual(await library.read('guoman_series', 'series-f-000'), { exists: true, document: { _id: 'series-f-000', id: 'series-f-000', title: 'series-f-000' } });
  assert.equal(backend.calls.length, 2);
  const mutation = createManagementTransport(backend);
  assert.deepEqual(await mutation.read('guoman_series', 'series-f-000'), { exists: true, document: { _id: 'series-f-000', id: 'series-f-000', title: 'newer' } });
  assert.equal(backend.calls.length, 3);
  await assert.rejects(() => library.commit({ reads: [], writes: [] }), /只读/);
});

test('five full pages require an empty terminal page and never truncate a sixth nonempty page', async () => {
  const records = Array.from({ length: 500 }, (_, index) => follow(`f-${String(index).padStart(3, '0')}`));
  const backend = manager((functionName, payload) => {
    assert.equal(functionName, 'list_follows_page');
    const page = records.filter((item) => item._id > payload.after).slice(0, 100);
    return rpc({ documents: page, related: related(page), next_after: page.length === 100 ? page.at(-1)._id : '' });
  });
  const listed = await createManagementTransport(backend).list('guoman_watch_state', { owner: 'alice', kind: 'follow' });
  assert.equal(listed.length, 500);
  assert.equal(backend.calls.length, 6);
  const tooMany = [...records, follow('f-500')];
  const overflow = manager((_, payload) => {
    const page = tooMany.filter((item) => item._id > payload.after).slice(0, 100);
    return rpc({ documents: page, related: related(page), next_after: page.length === 100 ? page.at(-1)._id : '' });
  });
  await assert.rejects(() => createManagementTransport(overflow).list('guoman_watch_state', { owner: 'alice', kind: 'follow' }), /超限/);
  assert.equal(overflow.calls.length, 6);
});

test('malformed SQL layers, foreign follows, and inconsistent related records fail closed', async () => {
  for (const response of [
    { Error: { Code: 'DENIED' } },
    { Columns: ['wrong'], Rows: ['["{}"]'] },
    { Columns: ['result'], Rows: ['not-json'] },
    { Columns: ['result'], Rows: ['["null"]'] },
  ]) {
    await assert.rejects(() => createManagementTransport(manager(() => response)).read('guoman_series', 'id'), /响应/);
  }
  for (const result of [
    { documents: [follow('a', 'bob')], related: related([follow('a', 'bob')]), next_after: '' },
    { documents: [follow('a')], related: [], next_after: '' },
    { documents: [follow('a')], related: [{ id: 'series-a', exists: true, document: { _id: 'other' } }], next_after: '' },
    { documents: [follow('a')], related: related([follow('a')]), next_after: 'a' },
  ]) {
    await assert.rejects(() => createManagementTransport(manager(() => rpc(result))).list('guoman_watch_state', { owner: 'alice', kind: 'follow' }), /列表|关联|游标|文档/);
  }
});

test('commit response loss is not replayed by transport or store', async () => {
  let committed = 0;
  const backend = manager((functionName) => {
    if (functionName === 'get_document') return rpc({ exists: false });
    if (functionName === 'commit_documents') {
      committed++;
      throw new Error('connection reset after send');
    }
    throw new Error('unexpected function');
  });
  let callbacks = 0;
  await assert.rejects(() => createPgStore(createManagementTransport(backend)).transaction(async (tx) => {
    callbacks++;
    await tx.put('guoman_watch_state', 'state-1', { owner: 'alice' });
  }), (error) => error instanceof CommitUnconfirmedError && error.code === 'TX_OUTCOME_UNKNOWN');
  assert.equal(callbacks, 1);
  assert.equal(committed, 1);
});

test('series point and related documents require a matching nonempty business id', async () => {
  for (const businessId of [undefined, '', 'other']) {
    await assert.rejects(
      () => createManagementTransport(manager(() => rpc({ exists: true, document: { _id: 'series-a', id: businessId } }))).read('guoman_series', 'series-a'),
      /文档响应无效/,
    );
    const record = follow('a');
    await assert.rejects(
      () => createManagementTransport(manager(() => rpc({ documents: [record], related: [{ id: record.seriesId, exists: true, document: { _id: record.seriesId, id: businessId } }], next_after: '' }))).list('guoman_watch_state', { owner: 'alice', kind: 'follow' }),
      /文档响应无效/,
    );
  }
});

test('nested array SQL row cannot masquerade as TX_RETRY and replay a write', async () => {
  let commits = 0;
  let callbacks = 0;
  const backend = manager((name) => {
    if (name === 'get_document') return rpc({ exists: false });
    if (name === 'commit_documents') {
      commits++;
      return { Columns: ['result'], Rows: [[JSON.stringify([JSON.stringify({ ok: false, code: 'TX_RETRY' })])]] };
    }
    throw new Error('unexpected SQL');
  });
  await assert.rejects(() => createPgStore(createManagementTransport(backend)).transaction(async (tx) => {
    callbacks++;
    await tx.put('guoman_watch_state', 'state-1', { owner: 'alice' });
  }), (error) => error instanceof CommitUnconfirmedError && error.code === 'TX_OUTCOME_UNKNOWN');
  assert.equal(callbacks, 1);
  assert.equal(commits, 1);
});
