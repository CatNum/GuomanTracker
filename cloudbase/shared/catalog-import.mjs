import { normalizeOfficialUrl } from './official-links.mjs';

const FIELDS = ['id','title','platform','url','cover','status','episodes','checkedAt','source','events',
  'days','time','schedule','scheduleCheckedAt','latestEpisode','metadataPending'];

/** prepareCatalog（校验导入资料）：保留编号，规范链接，不接受用户或凭证字段。 */
export function prepareCatalog(items) {
  if (!Array.isArray(items) || !items.length || items.length > 10000) throw new Error('目录数量无效');
  const ids = new Set();
  return items.map(item => {
    if (!item || typeof item !== 'object' || !/^[a-zA-Z0-9_-]{1,160}$/u.test(item.id || '') || ids.has(item.id)) throw new Error('节目标识无效或重复');
    ids.add(item.id);
    for (const [name,limit] of Object.entries({ title:200, platform:40, url:2048, cover:2048, status:40, episodes:200, checkedAt:80, source:2048 })) {
      if (typeof item[name] !== 'string' || item[name].length > limit) throw new Error('节目字段无效');
    }
    if (!item.title.trim() || item.title.length > 200 || !Number.isFinite(Date.parse(item.checkedAt))) throw new Error('节目名称或核验时间无效');
    const official = normalizeOfficialUrl(item.url);
    if (official.platform !== item.platform || !Array.isArray(item.events) || item.events.length > 5000 ||
        item.events.some(e => !e || !Number.isFinite(e.at) || typeof e.label !== 'string' || e.label.length > 100 || typeof e.published !== 'boolean' || typeof e.delayed !== 'boolean')) throw new Error('节目事件无效');
    if ((item.days !== undefined && (!Array.isArray(item.days) || item.days.length > 7 || item.days.some(day => !Number.isInteger(day) || day < 0 || day > 6))) ||
        (item.time !== undefined && (typeof item.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(item.time))) ||
        (item.schedule !== undefined && (typeof item.schedule !== 'string' || item.schedule.length > 500)) ||
        (item.scheduleCheckedAt !== undefined && (typeof item.scheduleCheckedAt !== 'string' || item.scheduleCheckedAt.length > 80 || !Number.isFinite(Date.parse(item.scheduleCheckedAt)))) ||
        (item.latestEpisode !== undefined && (!Number.isInteger(item.latestEpisode) || item.latestEpisode < 1 || item.latestEpisode > 10000)) ||
        (item.metadataPending !== undefined && typeof item.metadataPending !== 'boolean')) throw new Error('节目排期或发布字段无效');
    const record = Object.fromEntries(FIELDS.filter(key => Object.hasOwn(item,key)).map(key => [key,structuredClone(item[key])]));
    return { ...record, _id: item.id, url: official.url };
  });
}

/** catalogImportSql（生成受控目录写入）：默认只补缺失记录，显式更新仅接受较新资料。 */
export function catalogImportSql(records, { update = false } = {}) {
  if (!Array.isArray(records) || !records.length || records.length > 100) throw new Error('导入批次最多100条');
  const encoded = Buffer.from(JSON.stringify(records),'utf8');
  if (encoded.length > 128 * 1024) throw new Error('导入批次超过128KiB');
  const payload = Buffer.from(JSON.stringify({ items: records, update }), 'utf8').toString('hex');
  return `SELECT guoman_private.ingest_series_batch(convert_from(decode('${payload}','hex'),'UTF8')::jsonb) AS result`;
}

/** catalogLinkNormalization（规范旧PG链接）：保持原编号及全部其他字段，使用原文档作事务读集。 */
export function catalogLinkNormalization(documents) {
  const reads = [], writes = [];
  for (const document of documents) {
    if (typeof document?._id !== 'string' || document._id !== document.id) throw new Error('旧节目编号无效');
    const official = normalizeOfficialUrl(document.url);
    if (official.platform !== document.platform) throw new Error('旧节目平台不一致');
    if (official.url === document.url) continue;
    reads.push({ collection: 'guoman_series', id: document.id, exists: true, document });
    writes.push({ collection: 'guoman_series', id: document.id, op: 'put', document: { ...document, url: official.url } });
  }
  return { reads, writes };
}
