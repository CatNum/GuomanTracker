const TIMELINE_URL = 'https://api.bilibili.com/pgc/web/timeline?types=4&before=6&after=6';
const SUCCESS_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_DAYS = 20;
const MAX_EPISODES = 5000;
// Keep the UTC instant eight hours inside Date's limit because the UI formats Beijing time (UTC+8).
const MAX_PUBLISH_TIMESTAMP_SECONDS = 8.64e12 - 8 * 60 * 60;
const PLATFORMS = new Set(['bilibili', 'tencent', 'youku']);
const COVER_HOSTS = new Set(['i0.hdslb.com', 'i1.hdslb.com']);

function safeText(value, max = 500) {
  return typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function supportedSeed(items) {
  return items.filter((item) => item && PLATFORMS.has(item.platform));
}

async function readLimitedBody(response) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error('timeline body too large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error('timeline body too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function parseTimeline(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.code !== 0 || !Array.isArray(data.result) || data.result.length > MAX_DAYS) {
    throw new Error('invalid timeline');
  }
  let count = 0;
  const episodes = [];
  for (const day of data.result) {
    if (!day || typeof day !== 'object' || !Array.isArray(day.episodes)) throw new Error('invalid timeline day');
    count += day.episodes.length;
    if (count > MAX_EPISODES) throw new Error('too many timeline episodes');
    for (const episode of day.episodes) {
      if (!episode || typeof episode !== 'object' || !Number.isSafeInteger(episode.season_id) || episode.season_id <= 0 ||
          !Number.isSafeInteger(episode.pub_ts) || episode.pub_ts <= 0 || episode.pub_ts > MAX_PUBLISH_TIMESTAMP_SECONDS || !safeText(episode.title, 200) || !episode.title.trim() ||
          !safeText(episode.pub_index ?? '', 100) ||
          (episode.published !== undefined && typeof episode.published !== 'number' && typeof episode.published !== 'boolean') ||
          (episode.delay !== undefined && typeof episode.delay !== 'number' && typeof episode.delay !== 'boolean')) {
        throw new Error('invalid timeline episode');
      }
      if (episode.cover !== undefined && !safeText(episode.cover, 1000)) throw new Error('invalid timeline cover');
      episodes.push(episode);
    }
  }
  return episodes;
}

function officialCover(value) {
  if (typeof value !== 'string' || value.length > 1000) return '';
  const normalized = value.replace(/^http:/, 'https:');
  try {
    const url = new URL(normalized);
    return url.protocol === 'https:' && COVER_HOSTS.has(url.hostname) ? url.href : '';
  } catch { return ''; }
}

function mergeTimeline(seed, episodes, stamp) {
  const events = new Map();
  const fresh = new Map();
  for (const episode of episodes) {
    const id = `bili-${episode.season_id}`;
    const list = events.get(id) || [];
    list.push({ at: episode.pub_ts * 1000, label: episode.pub_index || '', published: !!episode.published, delayed: !!episode.delay });
    events.set(id, list);
    fresh.set(id, {
      id, title: episode.title, platform: 'bilibili',
      url: `https://www.bilibili.com/bangumi/play/ss${episode.season_id}`,
      cover: officialCover(episode.cover), status: 'ongoing', episodes: episode.pub_index || '', events: [],
      checkedAt: stamp, source: 'https://www.bilibili.com/guochuang/',
    });
  }
  const items = seed.map((item) => item.platform === 'bilibili'
    ? { ...item, events: events.get(item.id) || [], ...(events.has(item.id) ? { checkedAt: stamp } : {}) }
    : item);
  const known = new Set(items.map((item) => item.id));
  for (const [id, item] of fresh) if (!known.has(id)) items.push({ ...item, events: events.get(id) || [] });
  return items;
}

/** Create an isolated official catalog reader with injectable data and clock. */
export function createCatalogService({ loadSeed, fetchImpl = fetch, now = Date.now } = {}) {
  if (typeof loadSeed !== 'function' || typeof fetchImpl !== 'function' || typeof now !== 'function') throw new TypeError('catalog dependencies are required');
  let retained;
  let inflight;

  async function getCatalog() {
    const seed = supportedSeed(await loadSeed());
    if (retained && retained.expires > now()) return { items: retained.items, live: true };
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const response = await fetchImpl(TIMELINE_URL, {
          signal: AbortSignal.timeout(10_000),
          headers: { 'User-Agent': 'GuomanTracker/1.0' },
        });
        if (!response.ok) throw new Error('timeline unavailable');
        const body = await readLimitedBody(response);
        const episodes = parseTimeline(JSON.parse(body));
        const stamp = new Date(now()).toISOString();
        const items = mergeTimeline(seed, episodes, stamp);
        retained = { items, expires: now() + SUCCESS_TTL_MS };
        return { items, live: true };
      } catch {
        return { items: seed, live: false };
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  }
  return { getCatalog };
}
