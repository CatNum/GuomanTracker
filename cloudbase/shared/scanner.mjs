import { timingSafeEqual } from 'node:crypto';
import { normalizeOfficialUrl } from './official-links.mjs';
import { isSupportedPlatform } from './platform-support.mjs';
import { latestPublishedEpisode } from './published-episode.mjs';

const HOUR = 60 * 60 * 1000;
const MAX_SCAN = 20;
const MAX_HOT = 30;

function fault(code, message) {
  const error = new Error(message); error.code = code; return error;
}

function permittedFetchUrl(input, platform) {
  const parsed = new URL(input);
  if (platform === 'bilibili' && parsed.origin === 'https://api.bilibili.com' && parsed.pathname === '/pgc/view/web/season' && !parsed.username && !parsed.password) {
    const params = [...parsed.searchParams.entries()];
    if (params.length !== 1 || !['season_id', 'ep_id'].includes(params[0][0]) || !/^[1-9]\d*$/u.test(params[0][1])) throw fault('INVALID_URL', '官网 API 地址不符合预期。');
    return parsed.href;
  }
  const normalized = normalizeOfficialUrl(input);
  if (normalized.platform !== platform) throw fault('INVALID_URL', '节目链接不能跳转到其他平台。');
  // Preserve a legitimate original episode URL for the metadata request, while dropping tracking data.
  return normalized.url;
}

/** Reads only bounded text/JSON from validated official endpoints, checking every redirect. */
export async function fetchMetadata(input, { fetcher = fetch, timeoutMs = 8000, maxBytes = 2 * 1024 * 1024, maxRedirects = 3, platform } = {}) {
  const chosenPlatform = platform || normalizeOfficialUrl(input).platform;
  let url = permittedFetchUrl(input, chosenPlatform);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let attempt = 0; attempt <= maxRedirects; attempt += 1) {
      const response = await fetcher(url, { redirect: 'manual', signal: controller.signal, headers: { accept: 'application/json,text/html;q=0.9', 'user-agent': 'GuomanTracker-Metadata/0.2 (metadata only)' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || attempt === maxRedirects) throw fault('REDIRECT_LIMIT', '官网跳转超过限制。');
        url = permittedFetchUrl(new URL(location, url).href, chosenPlatform);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw fault('HTTP_ERROR', `官网返回 HTTP ${response.status}。`); }
      const type = (response.headers.get('content-type') || '').toLowerCase();
      if (!/^(?:application\/(?:json|[^;]+\+json)|text\/(?:html|plain))(?:;|$)/u.test(type)) {
        await response.body?.cancel(); throw fault('INVALID_CONTENT', '扫描仅接受官网文本或 JSON 元数据。');
      }
      const size = Number(response.headers.get('content-length'));
      if (Number.isFinite(size) && size > maxBytes) { await response.body?.cancel(); throw fault('BODY_TOO_LARGE', '官网页面超过元数据读取大小限制。'); }
      if (!response.body) throw fault('EMPTY_RESPONSE', '官网没有返回元数据。');
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) { await reader.cancel(); throw fault('BODY_TOO_LARGE', '官网页面超过元数据读取大小限制。'); }
        chunks.push(value);
      }
      const buffer = Buffer.concat(chunks);
      return { text: buffer.toString('utf8'), url, contentType: type };
    }
    throw fault('REDIRECT_LIMIT', '官网跳转超过限制。');
  } finally { clearTimeout(timer); }
}

function officialTimestamp(value) {
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  if (typeof value !== 'string') return NaN;
  // Bilibili pub_time is China local time when no offset is provided.
  const stamped = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value) ? `${value.replace(' ', 'T')}+08:00` : value;
  return Date.parse(stamped);
}

/** Uses released numbered episodes rather than the season's total planned episode count. */
export function parseBilibili(payload, now = new Date()) {
  const result = payload?.result;
  if (payload?.code !== 0 || !result || typeof result.title !== 'string' || !Array.isArray(result.episodes)) throw fault('UNSUPPORTED', '哔哩哔哩未返回可核验的剧集元数据。');
  const episodes = result.episodes.filter(episode => {
    const index = String(episode.title || '');
    const labels = `${episode.badge || ''} ${episode.long_title || ''}`;
    const at = officialTimestamp(episode.pub_time ?? episode.pub_real_time);
    return /^\d{1,5}$/u.test(index) && Number(index) > 0 && !episode.pv && !episode.is_view_hide && (!episode.section_type || episode.section_type === 0) && !/预告|花絮|PV|CM|先导|敬请|即将|预约/iu.test(labels) && Number.isFinite(at) && at <= +now;
  });
  if (!episodes.length) throw fault('UNSUPPORTED', '官网尚无能够核验为已发布的正片集数。');
  const latestEpisode = Math.max(...episodes.map(episode => Number(episode.title)));
  const cover = typeof result.cover === 'string' && result.cover.startsWith('https://') ? result.cover : undefined;
  const patch = { title: result.title.slice(0, 120), latestEpisode, episodes: `更新至第${latestEpisode}集`, status: result.publish?.is_finish === 1 ? 'finished' : 'ongoing' };
  if (cover) patch.cover = cover;
  return patch;
}

function decodeEntities(value) {
  return value.replace(/&quot;/gu, '"').replace(/&#39;|&apos;/gu, "'").replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&#(\d+);/gu, (_, number) => Number(number) <= 0x10ffff ? String.fromCodePoint(Number(number)) : '');
}

function metaFields(html) {
  const fields = new Map();
  for (const match of html.matchAll(/<meta\b([^>]{1,4096})>/giu)) {
    const attrs = new Map();
    for (const attr of match[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) attrs.set(attr[1].toLowerCase(), decodeEntities(attr[2] ?? attr[3]));
    const key = attrs.get('property') || attrs.get('name');
    if (key && attrs.has('content') && !fields.has(key.toLowerCase())) fields.set(key.toLowerCase(), attrs.get('content'));
  }
  return fields;
}

/** Other platforms: only explicit release information in the show's own metadata description is trusted. */
export function parseOfficialHtml(html) {
  const fields = metaFields(html);
  const title = fields.get('og:title') || fields.get('title');
  const description = fields.get('og:description') || fields.get('description') || '';
  // Generic titles, previews, planned totals and schedule prose cannot prove a released episode.
  if (!title || /登录|验证|访问受限|验证码/u.test(title) || /预告|预计|即将|预约|将更新|将于|下周|明日|明天|敬请|计划/u.test(description)) throw fault('UNSUPPORTED', '官网页面没有可核验的正片更新描述。');
  const released = [...description.matchAll(/(?:已更新至|更新至|更新到)\s*(?:第\s*)?(\d{1,5})\s*(?:集|话)/gu)].map(match => Number(match[1]));
  if (released.length !== 1 || released[0] < 1) throw fault('UNSUPPORTED', '官网页面未明确给出已发布的最新集数；已保留原信息。');
  const latestEpisode = released[0];
  const cleanTitle = title.replace(/\s*[-_|｜]\s*(?:腾讯视频|优酷|爱奇艺|芒果\s*TV|哔哩哔哩).*$/iu, '').trim().slice(0, 120);
  if (!cleanTitle) throw fault('UNSUPPORTED', '无法确认节目标题。');
  const patch = { title: cleanTitle, latestEpisode, episodes: `更新至第${latestEpisode}集` };
  const cover = fields.get('og:image');
  if (cover?.startsWith('https://')) patch.cover = cover;
  return patch;
}

export async function scanOfficialSeries(target, { now = new Date(), ...options } = {}) {
  const normalized = normalizeOfficialUrl(target.url);
  if (target.platform && normalized.platform !== target.platform) throw fault('INVALID_URL', '监控平台与官网链接不匹配。');
  if (!isSupportedPlatform(normalized.platform)) throw fault('UNSUPPORTED_PLATFORM', '目前仅支持哔哩哔哩、腾讯视频和优酷。');
  if (normalized.platform === 'bilibili') {
    const id = new URL(normalized.url).pathname.match(/\/(ss|ep)(\d+)$/u);
    const url = `https://api.bilibili.com/pgc/view/web/season?${id[1] === 'ss' ? 'season_id' : 'ep_id'}=${id[2]}`;
    const response = await fetchMetadata(url, { ...options, platform: 'bilibili' });
    let payload;
    try { payload = JSON.parse(response.text); } catch { throw fault('INVALID_JSON', '官网返回的 JSON 元数据不可解析。'); }
    return parseBilibili(payload, now);
  }
  const response = await fetchMetadata(normalized.url, { ...options, platform: normalized.platform });
  return parseOfficialHtml(response.text);
}

export function selectDueTargets(targets, now = new Date(), limit = MAX_SCAN) {
  return targets.filter(target => {
    if (!['user', 'hot'].includes(target.source)) return false;
    let platform = target.platform;
    if (!platform && target.url) {
      try { platform = normalizeOfficialUrl(target.url).platform; } catch { return false; }
    }
    return (!platform || isSupportedPlatform(platform)) && (!target.nextScanAt || Date.parse(target.nextScanAt) <= +now) && (!target.leaseUntil || Date.parse(target.leaseUntil) <= +now);
  })
    .sort((a, b) => Number(b.source === 'user') - Number(a.source === 'user') || Date.parse(a.nextScanAt || '1970-01-01') - Date.parse(b.nextScanAt || '1970-01-01') || String(a.seriesId).localeCompare(String(b.seriesId)))
    .slice(0, Math.min(MAX_SCAN, Math.max(0, Number(limit) || 0)));
}

/** Scans only supplied, bounded due targets; persistence is injected for isolated tests. */
export async function runScanBatch({ targets, store, now = new Date(), scanner = scanOfficialSeries, concurrency = 3 }) {
  const due = selectDueTargets(targets, now);
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), 3, due.length) }, async () => {
    while (cursor < due.length) {
      const target = due[cursor++];
      const id = target.seriesId;
      const baseline = target.source === 'user' ? 6 * HOUR : 24 * HOUR;
      // Production store claims a lease atomically, preventing overlapping timer invocations.
      if (store.claimTarget && !(await store.claimTarget(id, now))) continue;
      try {
        const known = await store.getSeries(id);
        if (!known) throw fault('SERIES_MISSING', '监控节目记录不存在。');
        const metadata = await scanner(target, { now });
        if (!Number.isSafeInteger(metadata.latestEpisode) || metadata.latestEpisode < 1 || metadata.latestEpisode > 10000) throw fault('UNSUPPORTED', '扫描结果缺少官网确认的正片集数。');
        const previousEpisode = latestPublishedEpisode(known, +now) || 0;
        const latestEpisode = Math.max(previousEpisode, metadata.latestEpisode);
        const nextScanAt = new Date(+now + baseline).toISOString();
        await store.updateSeries(id, { ...metadata, latestEpisode, episodes: `更新至第${latestEpisode}集`, checkedAt: now.toISOString(), source: target.url, monitoring: 'active', lastScanAt: now.toISOString(), nextScanAt, scanError: '' });
        await store.updateTarget(id, { status: 'active', failureCount: 0, lastScanAt: now.toISOString(), nextScanAt, leaseUntil: '', scanError: '' });
        results.push({ seriesId: id, status: 'active' });
      } catch (error) {
        const failureCount = Math.min(20, Math.max(0, target.failureCount || 0) + 1);
        const wait = Math.min(7 * 24 * HOUR, baseline * 2 ** Math.min(10, failureCount - 1));
        const nextScanAt = new Date(+now + wait).toISOString();
        const status = error.code === 'UNSUPPORTED' ? 'unsupported' : 'error';
        // Store only a bounded generic diagnostic, never raw page text or media payloads.
        const scanError = error.code === 'UNSUPPORTED' ? String(error.message).slice(0, 180) : `官方元数据扫描失败（${/^[A-Z_]+$/u.test(error.code || '') ? error.code : 'NETWORK_ERROR'}），稍后重试。`;
        await store.updateSeries(id, { monitoring: status, lastScanAttemptAt: now.toISOString(), nextScanAt, scanError });
        await store.updateTarget(id, { status, failureCount, lastScanAt: now.toISOString(), nextScanAt, leaseUntil: '', scanError });
        results.push({ seriesId: id, status });
      }
    }
  });
  await Promise.all(workers);
  return { scanned: results.length, results };
}

/** Requires a server-only high entropy timer secret and rejects trusted SDK caller identities. */
export function authorizeScanner(event, userInfo, secret) {
  if (!/^[a-f\d]{64}$/iu.test(secret || '') || event?.Type !== 'Timer') return false;
  if (userInfo?.uid || userInfo?.openId || userInfo?.openid || userInfo?.customUserId) return false;
  let message;
  try { message = JSON.parse(event.Message); } catch { return false; }
  if (typeof message.scanKey !== 'string' || Buffer.byteLength(message.scanKey) !== Buffer.byteLength(secret)) return false;
  return timingSafeEqual(Buffer.from(message.scanKey), Buffer.from(secret));
}

/** 创建明确指定的热门扫描目标，并保留用户已经提交的目标优先级。 */
export function seedHotTargets(series, existing = [], now = new Date()) {
  if (!Array.isArray(series) || series.length > MAX_HOT) throw fault('SEED_LIMIT', '热门扫描种子最多 30 个。');
  const userIds = new Set(existing.filter(target => target.source === 'user').map(target => target.seriesId));
  const unique = new Map();
  for (const item of series) {
    const normalized = normalizeOfficialUrl(item.url);
    if (!isSupportedPlatform(normalized.platform)) continue;
    const seriesId = item.id || normalized.id;
    if (!userIds.has(seriesId)) unique.set(seriesId, { seriesId, url: normalized.url, platform: normalized.platform, source: 'hot', status: 'queued', nextScanAt: now.toISOString(), failureCount: 0 });
  }
  return [...unique.values()];
}
