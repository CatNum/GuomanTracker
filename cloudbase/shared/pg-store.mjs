import { COLLECTIONS } from './user-service.mjs';
import { CommitUnconfirmedError } from './pg-errors.mjs';
export { CommitUnconfirmedError } from './pg-errors.mjs';

const ALLOWED_COLLECTIONS = new Set(Object.values(COLLECTIONS));
const MAX_KEYS = 128;
const MAX_ID_LENGTH = 256;
const MAX_COMMIT_BYTES = 256 * 1024;
const MAX_ATTEMPTS = 3;

class StoreValidationError extends TypeError {}
class StoreReadError extends Error {}

function checkKey(collection, id) {
  if (!ALLOWED_COLLECTIONS.has(collection)) throw new StoreValidationError('无效的集合');
  if (typeof id !== 'string' || !id || id.length > MAX_ID_LENGTH) throw new StoreValidationError('无效的文档编号');
  return JSON.stringify([collection, id]);
}

function copyDocument(document) {
  const seen = new WeakSet();
  function copy(value, depth) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || depth > 64 || seen.has(value)) throw new StoreValidationError('文档必须是有效 JSON 对象');
    if (Array.isArray(value)) {
      seen.add(value);
      const result = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) throw new StoreValidationError('文档必须是有效 JSON 对象');
        result.push(copy(value[index], depth + 1));
      }
      seen.delete(value);
      return result;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) {
      throw new StoreValidationError('文档必须是有效 JSON 对象');
    }
    seen.add(value);
    const result = {};
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!Object.hasOwn(descriptor, 'value')) throw new StoreValidationError('文档必须是有效 JSON 对象');
      Object.defineProperty(result, name, { value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    seen.delete(value);
    return result;
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) throw new StoreValidationError('文档必须是非空 JSON 对象');
  return copy(document, 0);
}

function normalizeRead(collection, id, response) {
  if (!response || typeof response.exists !== 'boolean') throw new StoreReadError('点读响应无效');
  return response.exists
    ? { collection, id, exists: true, document: copyDocument(response.document) }
    : { collection, id, exists: false };
}

function makeTransaction(transport) {
  const reads = new Map();
  const pending = new Map();
  const writes = new Map();

  async function original(collection, id) {
    const key = checkKey(collection, id);
    if (!reads.has(key) && !pending.has(key)) {
      if (reads.size + pending.size >= MAX_KEYS) throw new StoreValidationError('事务键数超限');
      const task = (async () => {
        try {
          let response;
          try { response = await transport.read(collection, id); }
          catch (cause) { throw new StoreReadError('点读失败', { cause }); }
          const value = normalizeRead(collection, id, response);
          reads.set(key, value);
          return value;
        } finally { pending.delete(key); }
      })();
      pending.set(key, task);
    }
    return { key, value: reads.get(key) ?? await pending.get(key) };
  }

  return {
    reads,
    writes,
    api: {
      async get(collection, id) {
        const { key, value } = await original(collection, id);
        const staged = writes.get(key);
        if (staged) return staged.op === 'remove' ? null : copyDocument(staged.document);
        return value.exists ? copyDocument(value.document) : null;
      },
      async put(collection, id, document) {
        const next = copyDocument(document);
        const { key } = await original(collection, id);
        writes.set(key, { collection, id, op: 'put', document: next });
      },
      async remove(collection, id) {
        const { key } = await original(collection, id);
        writes.set(key, { collection, id, op: 'remove' });
      },
    },
  };
}

function batchFor(state, includeWrites) {
  const batch = {
    reads: [...state.reads.values()].map((item) => structuredClone(item)),
    writes: includeWrites ? [...state.writes.values()].map((item) => structuredClone(item)) : [],
  };
  if (Buffer.byteLength(JSON.stringify(batch), 'utf8') > MAX_COMMIT_BYTES) throw new StoreValidationError('事务请求体超限');
  return batch;
}

async function commit(transport, batch) {
  let response;
  try { response = await transport.commit(batch); }
  catch (error) { throw new CommitUnconfirmedError(error); }
  if (response?.ok === true) return true;
  if (response?.ok === false && response.code === 'TX_RETRY') return false;
  // No recognized, definitive outcome: replaying the callback could duplicate a write.
  throw new CommitUnconfirmedError(new Error('提交响应无效或未确认'));
}

/**
 * Point operations use transport.read(collection,id) -> {exists,document} and
 * transport.commit({reads,writes}) -> {ok:true}|{ok:false,code:'TX_RETRY'}.
 * transport.list(collection,{owner,kind}) is only used outside transactions.
 * The transport must implement atomic read-set verification and write-set commit.
 */
export function createPgStore(transport) {
  if (!transport || ['read', 'list', 'commit'].some((name) => typeof transport[name] !== 'function')) {
    throw new TypeError('PG transport 缺少 read/list/commit');
  }
  return {
    async get(collection, id) {
      checkKey(collection, id);
      const found = normalizeRead(collection, id, await transport.read(collection, id));
      return found.exists ? copyDocument(found.document) : null;
    },
    async put(collection, id, document) {
      await this.transaction((tx) => tx.put(collection, id, document));
    },
    async remove(collection, id) {
      await this.transaction((tx) => tx.remove(collection, id));
    },
    async listFollows(owner) {
      const found = await transport.list(COLLECTIONS.watch, { owner, kind: 'follow' });
      if (!Array.isArray(found)) throw new Error('追番列表响应无效');
      return found.filter((document) => document?.owner === owner && document.kind === 'follow')
        .map(copyDocument).sort((a, b) => String(a._id ?? '').localeCompare(String(b._id ?? '')));
    },
    async transaction(callback) {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const state = makeTransaction(transport);
        let result;
        let callbackError;
        let callbackFailed = false;
        try { result = await callback(state.api); }
        catch (error) { callbackFailed = true; callbackError = error; }
        if (callbackFailed && (state.reads.size === 0 || callbackError instanceof StoreValidationError || callbackError instanceof StoreReadError)) throw callbackError;
        const accepted = await commit(transport, batchFor(state, !callbackFailed));
        if (!accepted) continue;
        if (callbackFailed) throw callbackError;
        return result;
      }
      const error = new Error('事务暂时繁忙，请稍后重试');
      error.code = 'TX_BUSY';
      throw error;
    },
  };
}
