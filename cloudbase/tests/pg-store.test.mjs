import test from 'node:test';
import assert from 'node:assert/strict';
import { createPgStore, CommitUnconfirmedError } from '../shared/pg-store.mjs';

const WATCH = 'guoman_watch_state';
const SERIES = 'guoman_series';
const key = (collection, id) => `${collection}/${id}`;

class MemoryTransport {
  rows = new Map();
  commits = 0;
  reads = 0;
  onCommit;
  async read(collection, id) {
    this.reads++;
    const document = this.rows.get(key(collection, id));
    return document === undefined
      ? { exists: false }
      : { exists: true, document: structuredClone(document) };
  }
  async list(collection, filter) {
    return [...this.rows.entries()]
      .filter(([id, document]) => id.startsWith(`${collection}/`) && document.owner === filter.owner && document.kind === filter.kind)
      .map(([, document]) => structuredClone(document));
  }
  async commit({ reads, writes }) {
    this.commits++;
    if (this.onCommit) return this.onCommit({ reads, writes }, this);
    for (const item of reads) {
      const actual = this.rows.get(key(item.collection, item.id));
      if ((actual !== undefined) !== item.exists ||
          (item.exists && JSON.stringify(actual) !== JSON.stringify(item.document)))
        return { ok: false, code: 'TX_RETRY' };
    }
    for (const item of writes) {
      if (item.op === 'remove') this.rows.delete(key(item.collection, item.id));
      else this.rows.set(key(item.collection, item.id), structuredClone(item.document));
    }
    return { ok: true };
  }
}

test('transaction repeats an exact read, isolates returned objects and reads its own staged write', async () => {
  const transport = new MemoryTransport();
  transport.rows.set(key(WATCH, 'watch-1'), { owner: 'alice', progress: { episode: 1 } });
  const store = createPgStore(transport);
  const result = await store.transaction(async (tx) => {
    const first = await tx.get(WATCH, 'watch-1');
    first.progress.episode = 99;
    assert.equal((await tx.get(WATCH, 'watch-1')).progress.episode, 1);
    const next = { owner: 'alice', progress: { episode: 2 } };
    await tx.put(WATCH, 'watch-1', next);
    next.progress.episode = 88;
    assert.equal((await tx.get(WATCH, 'watch-1')).progress.episode, 2);
    return 'saved';
  });
  assert.equal(result, 'saved');
  assert.equal(transport.reads, 1);
  assert.deepEqual(transport.rows.get(key(WATCH, 'watch-1')), { owner: 'alice', progress: { episode: 2 } });
});

test('simultaneous first reads of one key share one original snapshot', async () => {
  const transport = new MemoryTransport();
  transport.rows.set(key(WATCH, 'watch-1'), { episode: 1 });
  const underlyingRead = transport.read.bind(transport);
  transport.read = async (collection, id) => {
    const captured = await underlyingRead(collection, id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return captured;
  };
  const values = await createPgStore(transport).transaction(async (tx) => Promise.all([
    tx.get(WATCH, 'watch-1'), tx.get(WATCH, 'watch-1'),
  ]));
  assert.deepEqual(values, [{ episode: 1 }, { episode: 1 }]);
  assert.equal(transport.reads, 1);
});

test('unread put and remove capture original values; concurrent change retries callback before overwrite', async () => {
  const transport = new MemoryTransport();
  transport.rows.set(key(WATCH, 'remove-1'), { owner: 'alice', value: 1 });
  const store = createPgStore(transport);
  let attempts = 0;
  transport.onCommit = async (batch, database) => {
    database.onCommit = null;
    database.rows.set(key(WATCH, 'remove-1'), { owner: 'alice', value: 2 });
    return { ok: false, code: 'TX_RETRY' };
  };
  await store.transaction(async (tx) => {
    attempts++;
    await tx.put(WATCH, 'new-1', { owner: 'alice', value: attempts });
    await tx.remove(WATCH, 'remove-1');
  });
  assert.equal(attempts, 2);
  assert.deepEqual(transport.rows.get(key(WATCH, 'new-1')), { owner: 'alice', value: 2 });
  assert.equal(transport.rows.has(key(WATCH, 'remove-1')), false);
  assert.equal(transport.reads, 4);
});

test('only explicit TX_RETRY repeats up to three total attempts', async () => {
  const transport = new MemoryTransport();
  transport.onCommit = async () => ({ ok: false, code: 'TX_RETRY' });
  const store = createPgStore(transport);
  let attempts = 0;
  await assert.rejects(() => store.transaction(async (tx) => {
    attempts++;
    await tx.put(WATCH, 'quota-1', { count: attempts });
  }), /繁忙/);
  assert.equal(attempts, 3);
  assert.equal(transport.commits, 3);
  assert.equal(transport.rows.has(key(WATCH, 'quota-1')), false);
});

test('commit response lost after applying writes is uncertain and never automatically replayed', async () => {
  const transport = new MemoryTransport();
  transport.onCommit = async (batch, database) => {
    for (const item of batch.writes) database.rows.set(key(item.collection, item.id), item.document);
    throw new Error('network timeout');
  };
  let attempts = 0;
  await assert.rejects(() => createPgStore(transport).transaction(async (tx) => {
    attempts++;
    await tx.put(WATCH, 'quota-1', { count: attempts });
  }), (error) => error instanceof CommitUnconfirmedError && /保存结果未确认/.test(error.message));
  assert.equal(attempts, 1);
  assert.deepEqual(transport.rows.get(key(WATCH, 'quota-1')), { count: 1 });
});

test('callback failure never commits staged writes; stale error read retries against fresh state', async () => {
  const transport = new MemoryTransport();
  transport.rows.set(key(WATCH, 'version-1'), { version: 1 });
  const store = createPgStore(transport);
  let attempts = 0;
  await assert.rejects(() => store.transaction(async (tx) => {
    attempts++;
    const current = await tx.get(WATCH, 'version-1');
    await tx.put(WATCH, 'draft-1', { version: current.version });
    if (attempts === 1) transport.rows.set(key(WATCH, 'version-1'), { version: 2 });
    throw new Error(`business version ${current.version}`);
  }), /business version 2/);
  assert.equal(attempts, 2);
  assert.equal(transport.rows.has(key(WATCH, 'draft-1')), false);
  assert.equal(transport.commits, 2);
});

test('falsy thrown values abort staged writes and are rethrown unchanged', async () => {
  for (const reason of [undefined, null, false, 0, '']) {
    const transport = new MemoryTransport();
    let submittedWrites = -1;
    transport.onCommit = async (batch) => {
      submittedWrites = batch.writes.length;
      return { ok: true };
    };
    const marker = Symbol('not thrown');
    let caught = marker;
    try {
      await createPgStore(transport).transaction(async (tx) => {
        await tx.put(WATCH, 'aborted', { count: 1 });
        throw reason;
      });
    } catch (error) { caught = error; }
    assert.notEqual(caught, marker);
    assert.equal(caught, reason);
    assert.equal(submittedWrites, 0);
    assert.equal(transport.rows.has(key(WATCH, 'aborted')), false);
  }
});

test('falsy callback failure retries a stale read with empty writes before rethrowing', async () => {
  const transport = new MemoryTransport();
  transport.rows.set(key(WATCH, 'source'), { value: 1 });
  let attempts = 0;
  let caught = Symbol('not thrown');
  try {
    await createPgStore(transport).transaction(async (tx) => {
      attempts++;
      await tx.get(WATCH, 'source');
      await tx.put(WATCH, 'aborted', { value: attempts });
      if (attempts === 1) transport.rows.set(key(WATCH, 'source'), { value: 2 });
      throw undefined;
    });
  } catch (error) { caught = error; }
  assert.equal(caught, undefined);
  assert.equal(attempts, 2);
  assert.equal(transport.rows.has(key(WATCH, 'aborted')), false);
});

test('read-only callback validates snapshot before returning its result', async () => {
  const transport = new MemoryTransport();
  transport.rows.set(key(SERIES, 'series-1'), { episode: 1 });
  let attempts = 0;
  const result = await createPgStore(transport).transaction(async (tx) => {
    attempts++;
    const found = await tx.get(SERIES, 'series-1');
    if (attempts === 1) transport.rows.set(key(SERIES, 'series-1'), { episode: 2 });
    return found.episode;
  });
  assert.equal(result, 2);
  assert.equal(attempts, 2);
  assert.equal(transport.commits, 2);
});

test('invalid collection, id or document fails before remote calls', async () => {
  const transport = new MemoryTransport();
  const store = createPgStore(transport);
  await assert.rejects(() => store.transaction((tx) => tx.get('other', 'id')), /集合/);
  await assert.rejects(() => store.transaction((tx) => tx.get(WATCH, 'x'.repeat(257))), /编号/);
  await assert.rejects(() => store.transaction((tx) => tx.put(WATCH, 'id', null)), /文档/);
  await assert.rejects(() => store.transaction((tx) => tx.put(WATCH, 'id', new Date())), /文档/);
  await assert.rejects(() => store.transaction((tx) => tx.put(WATCH, 'id', { nested: { updated: new Date() } })), /文档/);
  await assert.rejects(() => store.transaction((tx) => tx.put(WATCH, 'id', { progress: Number.NaN })), /文档/);
  await assert.rejects(() => store.transaction((tx) => tx.put(WATCH, 'id', { progress: undefined })), /文档/);
  assert.equal(transport.reads, 0);
  assert.equal(transport.commits, 0);
});

test('point-read and commit payload limits stop oversized transactions before submission', async () => {
  const transport = new MemoryTransport();
  const store = createPgStore(transport);
  await assert.rejects(() => store.transaction(async (tx) => {
    for (let index = 0; index < 129; index++) await tx.get(WATCH, `item-${index}`);
  }), /键数/);
  await assert.rejects(() => store.transaction((tx) => tx.put(WATCH, 'large', { text: '字'.repeat(90_000) })), /请求体/);
  assert.equal(transport.commits, 0);
  assert.equal(transport.rows.has(key(WATCH, 'large')), false);
});

test('listFollows is an outside-transaction owner and kind scoped read', async () => {
  const transport = new MemoryTransport();
  transport.rows.set(key(WATCH, 'b'), { _id: 'b', owner: 'alice', kind: 'follow' });
  transport.rows.set(key(WATCH, 'a'), { _id: 'a', owner: 'alice', kind: 'follow' });
  transport.rows.set(key(WATCH, 'c'), { _id: 'c', owner: 'bob', kind: 'follow' });
  transport.rows.set(key(WATCH, 'd'), { _id: 'd', owner: 'alice', kind: 'stats' });
  const records = await createPgStore(transport).listFollows('alice');
  assert.deepEqual(records.map((record) => record._id), ['a', 'b']);
  assert.equal(transport.commits, 0);
});
