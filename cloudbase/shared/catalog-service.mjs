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
