import { normalizeOfficialUrl } from './official-links.mjs';
import { isSupportedPlatform } from './platform-support.mjs';
import { fetchMetadata } from './scanner.mjs';
import { tencentPageRequest } from './tencent-page.mjs';

const MAX_TITLE_LENGTH = 120;
const TITLE_ELEMENT_LIMIT = 4096;
const FETCH_FAILURE_CODES = new Set(['HTTP_ERROR', 'REDIRECT_LIMIT', 'INVALID_CONTENT', 'BODY_TOO_LARGE', 'EMPTY_RESPONSE', 'INVALID_URL']);
const PARSE_FAILURE_CODES = new Set(['INVALID_JSON', 'UNSUPPORTED']);
const FAILURE_CODES = new Set([...FETCH_FAILURE_CODES, ...PARSE_FAILURE_CODES, 'TIMEOUT', 'NETWORK_ERROR', 'UNKNOWN_ERROR']);

function reportMetadataFailure(reportFailure, normalized, error, fetchErrors) {
  const originalCode = typeof error?.code === 'string' && FAILURE_CODES.has(error.code) ? error.code : undefined;
  const code = error?.name === 'AbortError' ? 'TIMEOUT' : originalCode || (fetchErrors.has(error) ? 'NETWORK_ERROR' : 'UNKNOWN_ERROR');
  const stage = PARSE_FAILURE_CODES.has(code) ? 'parse' : FETCH_FAILURE_CODES.has(code) || fetchErrors.has(error) ? 'fetch' : 'resolve';
  const report = { event: 'guoman.metadata.failure', platform: normalized.platform, stage, code };
  if (code === 'HTTP_ERROR' && Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) report.status = error.status;
  try { reportFailure(report); } catch { /* Diagnostics must not replace the original resolver failure. */ }
}

function fault(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function checkedOfficial(official) {
  if (!official || typeof official !== 'object' || typeof official.url !== 'string') {
    throw fault('INVALID_URL', '请提供有效的官方节目链接。');
  }
  const normalized = normalizeOfficialUrl(official.url);
  if (!isSupportedPlatform(normalized.platform) || official.platform !== normalized.platform) {
    throw fault('INVALID_URL', '节目链接与平台不匹配。');
  }
  return normalized;
}

function decodeEntities(value) {
  return value.replace(/&(#(?:x[\da-f]{1,6}|\d{1,7})|amp|quot|apos|lt|gt|nbsp);/giu, (entity, code) => {
    const normalized = code.toLowerCase();
    if (normalized === 'amp') return '&';
    if (normalized === 'quot') return '"';
    if (normalized === 'apos') return "'";
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    if (normalized === 'nbsp') return ' ';
    const number = normalized.startsWith('#x') ? Number.parseInt(normalized.slice(2), 16) : Number.parseInt(normalized.slice(1), 10);
    if (!Number.isInteger(number) || number < 1 || number > 0x10ffff || (number >= 0xd800 && number <= 0xdfff)) return '';
    return String.fromCodePoint(number);
  });
}

function extractTitleMeta(html) {
  let title;
  let cover;
  for (const match of html.matchAll(/<meta\b([^>]{1,4096})>/giu)) {
    const attrs = new Map();
    for (const attr of match[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu)) {
      attrs.set(attr[1].toLowerCase(), decodeEntities(attr[2] ?? attr[3] ?? attr[4]));
    }
    const key = (attrs.get('property') || attrs.get('name') || '').toLowerCase();
    if (!title && ['og:title', 'twitter:title', 'title'].includes(key)) title = attrs.get('content');
    if (!cover && ['og:image', 'twitter:image'].includes(key)) cover = attrs.get('content');
  }
  return { title, cover };
}

function extractElementTitle(html) {
  const match = html.match(/<title\b[^>]*>([\s\S]{0,4096}?)<\/title\s*>/iu);
  return match ? decodeEntities(match[1].replace(/<[^>]{0,256}>/gu, ' ')) : undefined;
}

function cleanTitle(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]*>/gu, ' ')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s*[-_|｜]\s*(?:腾讯视频|腾讯视频\s*VIP|优酷|爱奇艺|芒果\s*TV|哔哩哔哩|bilibili|youku|腾讯视频官网|优酷视频).*$/iu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH);
}

function isRejectedTitle(value) {
  const title = value.trim();
  if (!title || /登录|登陆|验证|验证码|访问受限|访问异常|安全验证|系统繁忙|页面不存在|出错了|网络错误/iu.test(title)) return true;
  if (/^(?:腾讯视频(?:官网)?|优酷(?:视频)?(?:官网)?|首页|官方首页|视频播放|视频详情)$/iu.test(title)) return true;
  if (/^(?:欢迎来到)?(?:腾讯视频|优酷)(?:官网)?[！!。.]?$/iu.test(title)) return true;
  if (/(?:腾讯视频|优酷).{0,24}(?:不负好时光|这世界很酷|让好内容不负好时光)/iu.test(title)) return true;
  return false;
}

function isGenericBrandMarketingTitle(value) {
  return /^\s*(?:腾讯视频|优酷(?:视频)?)\s*[-_|｜:：]\s*(?:中国领先的在线视频媒体平台|海量高清视频在线观看|为好内容全力以赴|不负好时光|这世界很酷|让好内容不负好时光)/iu.test(value);
}

function makeResult(titleValue, coverValue) {
  if (typeof titleValue === 'string' && isGenericBrandMarketingTitle(titleValue)) {
    throw fault('UNSUPPORTED', '官方页面没有可确认的节目标题。');
  }
  const title = cleanTitle(titleValue);
  if (isRejectedTitle(title)) throw fault('UNSUPPORTED', '官方页面没有可确认的节目标题。');
  const result = { title };
  if (typeof coverValue === 'string') {
    try {
      const cover = new URL(coverValue);
      if (cover.protocol === 'https:' && !cover.username && !cover.password) result.cover = cover.href;
    } catch { /* Invalid cover images are omitted from the safe result. */ }
  }
  return result;
}

function tencentCards(card) {
  return Object.values(card?.children_list || {}).flatMap(group => Array.isArray(group?.cards) ? group.cards : []);
}

function tencentMetadata(payload, requestedCid, requestedVid) {
  if (payload?.ret !== 0 || !Array.isArray(payload.data?.CardList)) throw fault('UNSUPPORTED', '官方页面没有返回可确认的节目标题。');
  const modules = payload.data.CardList;
  let cid = requestedCid;
  if (!cid) {
    const matchingCids = new Set(modules.filter(card => card?.type === 'pc_web_episode_list')
      .flatMap(tencentCards)
      .map(card => card?.params)
      .filter(params => params?.vid === requestedVid && /^[a-zA-Z0-9]{3,64}$/u.test(params?.cid || ''))
      .map(params => params.cid));
    if (matchingCids.size !== 1) throw fault('UNSUPPORTED', '官方页面没有返回唯一匹配的节目。');
    [cid] = matchingCids;
  }
  const matches = modules.filter(card => card?.type === 'pc_introduction')
    .flatMap(tencentCards)
    .map(card => card?.params)
    .filter(params => params?.['report.cid'] === cid);
  if (matches.length !== 1 || typeof matches[0].title !== 'string') throw fault('UNSUPPORTED', '官方页面没有返回唯一匹配的节目标题。');
  return makeResult(matches[0].title, matches[0].new_pic_vt || matches[0].new_pic_hz);
}

async function readOfficial(normalized, { readMetadata }) {
  if (normalized.platform === 'bilibili') {
    const id = normalized.url.match(/\/(ss|ep)([1-9]\d*)$/u);
    const parameter = id[1] === 'ss' ? 'season_id' : 'ep_id';
    const url = `https://api.bilibili.com/pgc/view/web/season?${parameter}=${id[2]}`;
    const { text } = await readMetadata(url, { platform: 'bilibili' });
    let payload;
    try { payload = JSON.parse(text); } catch { throw fault('INVALID_JSON', '官方标题数据无法解析。'); }
    const item = payload?.code === 0 ? payload.result : undefined;
    if (!item || typeof item.title !== 'string') throw fault('UNSUPPORTED', '官方页面没有返回可确认的节目标题。');
    return makeResult(item.title, item.cover);
  }

  if (normalized.platform === 'tencent') {
    const url = new URL(normalized.url);
    const cid = url.pathname.match(/^\/x\/cover\/([a-zA-Z0-9]{3,64})\.html$/u)?.[1] || '';
    const vid = url.pathname.match(/^\/x\/page\/([a-zA-Z0-9]{3,64})\.html$/u)?.[1] || '';
    const request = tencentPageRequest({ page_type: 'detail', page_id: 'detail', cid, vid });
    const { text } = await readMetadata(request.url, request);
    let payload;
    try { payload = JSON.parse(text); } catch { throw fault('INVALID_JSON', '官方标题数据无法解析。'); }
    return tencentMetadata(payload, cid, vid);
  }

  const { text } = await readMetadata(normalized.url, { platform: normalized.platform });
  const metadata = extractTitleMeta(text);
  const title = metadata.title ?? extractElementTitle(text);
  // Check the raw candidate too, so a failed auth/challenge meta tag cannot be bypassed by <title>.
  if (typeof metadata.title === 'string' && isRejectedTitle(cleanTitle(metadata.title))) {
    throw fault('UNSUPPORTED', '官方页面要求登录、验证或暂时无法访问。');
  }
  if (typeof title !== 'string' || title.length > TITLE_ELEMENT_LIMIT) throw fault('UNSUPPORTED', '官方页面没有可确认的节目标题。');
  return makeResult(title, metadata.cover);
}

/** Reads only a verified official title and optional HTTPS cover for link-only submissions. */
export async function resolveOfficialMetadata(official, { fetcher = fetch, timeoutMs = 5000, maxBytes = 2 * 1024 * 1024, reportFailure = report => console.warn(JSON.stringify(report)) } = {}) {
  const normalized = checkedOfficial(official);
  const fetchErrors = new WeakSet();
  const readMetadata = async (url, requestOptions) => {
    try { return await fetchMetadata(url, { fetcher, timeoutMs, maxBytes, ...requestOptions }); } catch (error) {
      if (error && (typeof error === 'object' || typeof error === 'function')) fetchErrors.add(error);
      throw error;
    }
  };
  try {
    return await readOfficial(normalized, { readMetadata });
  } catch (error) {
    if (error?.code !== 'INVALID_URL') reportMetadataFailure(reportFailure, normalized, error, fetchErrors);
    throw error;
  }
}
