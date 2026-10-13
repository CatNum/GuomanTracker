import { COLLECTIONS } from './user-service.mjs';

const FUNCTIONS = Object.freeze({ read: 'get_document', list: 'list_follows_page', commit: 'commit_documents', catalog: 'list_series_page', find: 'find_series_by_url' });
const ALLOWED = new Set(Object.values(COLLECTIONS));
const LIMIT = 256 * 1024;
const compare = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const key = (collection, id) => JSON.stringify([collection, id]);

function checkId(id) {
  if (typeof id !== 'string' || !id || id.length > 256) throw new TypeError('无效的文档编号');
}
function checkCollection(collection) {
  if (!ALLOWED.has(collection)) throw new TypeError('无效的集合');
}
function checkDocument(document, id, collection) {
  if (!object(document) || document._id !== id || (collection === COLLECTIONS.series && (typeof document.id !== 'string' || !document.id || document.id !== id))) throw new Error('文档响应无效');
}

/** The manager is injected per request; no credential or user-data cache is global. */
export function createManagementTransport(manager, { libraryMode = false } = {}) {
  if (typeof manager?.database?.executePGSql !== 'function') throw new TypeError('管理 SQL 接口不可用');
  const cache = new Map();

  async function call(operation, payload) {
    const name = FUNCTIONS[operation];
    if (!name) throw new TypeError('无效存储操作');
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json, 'utf8') > LIMIT) throw new TypeError('存储请求体超限');
    const hex = Buffer.from(json, 'utf8').toString('hex');
    if (!/^[0-9a-f]+$/.test(hex)) throw new TypeError('存储编码无效');
    const Sql = `SELECT guoman_private.${name}(pg_catalog.convert_from(pg_catalog.decode('${hex}', 'hex'), 'UTF8')::jsonb) AS result`;
    // One SDK call. In particular, never replay an uncertain commit response.
    const response = await manager.database.executePGSql({ Sql });
    if (response?.Error || !Array.isArray(response?.Columns) || response.Columns.length !== 1 || response.Columns[0] !== 'result' || !Array.isArray(response?.Rows) || response.Rows.length !== 1) throw new Error('SQL 响应未确认');
    let data;
    try {
      if (typeof response.Rows[0] !== 'string') throw new Error();
      const row = JSON.parse(response.Rows[0]);
      if (!Array.isArray(row) || row.length !== 1 || typeof row[0] !== 'string') throw new Error();
      data = JSON.parse(row[0]);
    } catch { throw new Error('SQL 行响应未确认'); }
    if (!object(data)) throw new Error('SQL JSON 响应未确认');
    return data;
  }

  return {
    async listSeriesPage(after = '') {
      if (typeof after !== 'string' || after.length > 256) throw new TypeError('目录游标无效');
      const result = await call('catalog', { after });
      if (!Array.isArray(result.documents) || result.documents.length > 200 || typeof result.next_after !== 'string') throw new Error('目录响应无效');
      let last = after;
      for (const document of result.documents) {
        checkDocument(document, document?._id, COLLECTIONS.series);
        checkId(document._id);
        if (compare(document._id, last) <= 0) throw new Error('目录排序无效');
        last = document._id;
      }
      if (result.next_after && (result.documents.length !== 200 || result.next_after !== last)) throw new Error('目录游标无效');
      return result;
    },
    async findSeriesByUrl(url) {
      if (typeof url !== 'string' || !url || url.length > 2048) throw new TypeError('节目链接无效');
      const result = await call('find', { url });
      if (typeof result.exists !== 'boolean' || (!result.exists && Object.hasOwn(result, 'document'))) throw new Error('节目查询无效');
      if (!result.exists) return null;
      checkDocument(result.document, result.document?._id, COLLECTIONS.series);
      if (result.document.url !== url) throw new Error('节目链接不一致');
      return result.document;
    },
    async read(collection, id) {
      checkCollection(collection);
      checkId(id);
      const cached = libraryMode && collection === COLLECTIONS.series ? cache.get(key(collection, id)) : undefined;
      if (cached) return structuredClone(cached);
      const result = await call('read', { collection, id });
      if (typeof result.exists !== 'boolean' || (result.exists ? !object(result.document) : Object.hasOwn(result, 'document'))) throw new Error('点读响应无效');
      if (result.exists) checkDocument(result.document, id, collection);
      return result;
    },
    async list(collection, { owner, kind }) {
      if (collection !== COLLECTIONS.watch || kind !== 'follow' || typeof owner !== 'string' || !owner || owner.length > 256) throw new TypeError('无效列表操作');
      const documents = [];
      const warming = new Map();
      let after = '';
      for (let page = 0; page < 6; page++) {
        const result = await call('list', { owner, after });
        if (!Array.isArray(result.documents) || result.documents.length > 100 || !Array.isArray(result.related) || typeof result.next_after !== 'string') throw new Error('列表响应无效');
        const relatedIds = new Set();
        let last = after;
        for (const document of result.documents) {
          if (!object(document) || document.owner !== owner || document.kind !== 'follow' || typeof document.seriesId !== 'string' || !document.seriesId || typeof document._id !== 'string' || !document._id || compare(document._id, last) <= 0) throw new Error('列表记录或游标无效');
          checkId(document.seriesId);
          checkId(document._id);
          relatedIds.add(document.seriesId);
          documents.push(document);
          last = document._id;
        }
        if (documents.length > 500) throw new Error('追番数量超限');
        const seenRelated = new Set();
        for (const item of result.related) {
          if (!object(item) || typeof item.id !== 'string' || !relatedIds.has(item.id) || seenRelated.has(item.id) || typeof item.exists !== 'boolean' || (!item.exists && Object.hasOwn(item, 'document'))) throw new Error('关联节目响应无效');
          if (item.exists) checkDocument(item.document, item.id, COLLECTIONS.series);
          seenRelated.add(item.id);
          if (libraryMode) warming.set(key(COLLECTIONS.series, item.id), structuredClone(item.exists ? { exists: true, document: item.document } : { exists: false }));
        }
        if (seenRelated.size !== relatedIds.size) throw new Error('关联节目响应无效');
        if (result.documents.length === 100) {
          if (result.next_after !== last) throw new Error('列表游标无效');
          after = last;
        } else {
          if (result.next_after !== '') throw new Error('列表游标无效');
          if (libraryMode) for (const [id, value] of warming) cache.set(id, value);
          return documents;
        }
      }
      throw new Error('列表分页超限');
    },
    async commit(batch) {
      if (libraryMode) throw new Error('账号库只读请求不能提交');
      const result = await call('commit', batch);
      if (result.ok === true || (result.ok === false && result.code === 'TX_RETRY')) return result;
      throw new Error('提交响应未确认');
    },
  };
}
