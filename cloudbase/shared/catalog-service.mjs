import { isSupportedPlatform } from './platform-support.mjs';

const PUBLIC_FIELDS = ['id', 'title', 'platform', 'url', 'cover', 'status', 'episodes', 'checkedAt', 'source',
  'events', 'days', 'time', 'schedule', 'scheduleCheckedAt', 'latestEpisode', 'metadataPending', 'monitoring', 'lastScanAt'];
const validPayload = (p) => p && typeof p === 'object' && !Array.isArray(p) &&
  Object.keys(p).every(key => key === 'after') && (p.after === undefined ||
    (typeof p.after === 'string' && p.after.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(p.after)));

/** createCatalogService（PG目录读取服务）：只读分页并仅返回公开节目字段。 */
export function createCatalogService({ store }) {
  return { async getCatalog(payload = {}) {
    if (!validPayload(payload)) throw new TypeError('目录参数无效');
    const page = await store.listSeriesPage(payload.after || '');
    return { items: page.documents.filter(item => isSupportedPlatform(item.platform)).map(item =>
      Object.fromEntries(PUBLIC_FIELDS.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]]))),
      nextAfter: page.next_after };
  } };
}

/** createCatalogHandler（公开只读入口）：允许游客读取目录，拒绝其他动作及任意查询。 */
export function createCatalogHandler({ createStore }) {
  return async (event) => {
    if (event?.action !== 'getCatalog' || !validPayload(event.payload))
      return { ok: false, error: { code: 'INVALID_REQUEST', message: '目录请求格式无效。' } };
    try {
      return { ok: true, data: await createCatalogService({ store: createStore() }).getCatalog(event.payload) };
    } catch {
      return { ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: '目录读取失败，请稍后重试。' } };
    }
  };
}

/** createCatalogHttpHandler（公共HTTP目录入口）：校验固定路径和请求体后复用只读服务。 */
export function createCatalogHttpHandler(options) {
  const read = createCatalogHandler(options);
  const headers = { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  const reply = (statusCode, value) => ({ statusCode, headers,
    body: value === undefined ? '' : JSON.stringify(value) });
  const invalid = () => reply(400, { ok: false, error: { code: 'INVALID_REQUEST', message: '目录请求格式无效。' } });
  return async (event) => {
    // 默认网关可剥去触发前缀；OPA仍限定外部完整路径为/api/catalog。
    if (!['/api/catalog', '/'].includes(event?.path)) return reply(404, { ok: false });
    if (event.httpMethod === 'OPTIONS') return reply(204);
    if (event.httpMethod !== 'POST') return reply(405, { ok: false });
    if (event.isBase64Encoded || typeof event.body !== 'string' || Buffer.byteLength(event.body, 'utf8') > 4096) return invalid();
    let body;
    try { body = JSON.parse(event.body); } catch { return invalid(); }
    const value = await read(body);
    return reply(value.ok ? 200 : value.error.code === 'INVALID_REQUEST' ? 400 : 503, value);
  };
}
