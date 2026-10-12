import { createHash } from 'node:crypto';
import { normalizeOfficialUrl } from './official-links.mjs';
import { latestPublishedEpisode } from './published-episode.mjs';
import { normalizeEpisodeProgress, validEpisodeProgress } from './episode-progress.mjs';
import { CommitUnconfirmedError } from './pg-errors.mjs';
import { isSupportedPlatform, pendingSeriesTitle } from './platform-support.mjs';

export const COLLECTIONS = Object.freeze({ series: 'guoman_series', watch: 'guoman_watch_state', targets: 'guoman_monitor_targets' });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const followId = (uid, seriesId) => `watch-${hash(JSON.stringify([uid, seriesId]))}`;
const quotaId = (uid, day) => `quota-${hash(JSON.stringify([uid, day]))}`;
const statsId = (uid) => `stats-${hash(uid)}`;
const scanQuotaId = (uid, day) => `scan-quota-${hash(JSON.stringify([uid, day]))}`;
const chinaDay = (date) => new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
class UserError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const reject = (code, message) => { throw new UserError(code, message); };
const cleanFollow = ({ owner, kind, _id, ...follow }) => normalizeEpisodeProgress(follow);
const cleanSeries = ({ _id, submittedBy, ...series }) => series;

/** Creates the authenticated domain service. Identity is supplied by the trusted cloud-function entry, never by event data. */
export function createUserService({ store, seed = [], now = () => new Date() }) {
  const seedsById = new Map(seed.map((series) => [series.id, series]));
  const seedsByUrl = new Map();
  for (const series of seed) {
    try { seedsByUrl.set(normalizeOfficialUrl(series.url).url, series); } catch { /* Invalid legacy links remain visible but cannot be submitted. */ }
  }
  async function lookupSeries(id, boundary = store) {
    return await boundary.get(COLLECTIONS.series, id) ?? seedsById.get(id) ?? null;
  }
  function newFollow(uid, seriesId, at) {
    return { owner: uid, kind: 'follow', seriesId, currentEpisode: 0, episodeCompleted: false, paused: false, updatedAt: at, version: 1 };
  }
  function requireOwned(follow, uid) {
    if (!follow || follow.owner !== uid || follow.kind !== 'follow') reject('NOT_FOLLOWING', '请先追番，再记录观看进度。');
  }
  const ownedFollow = (follow, uid) => follow?.owner === uid && follow.kind === 'follow';
  async function readLimits(tx, uid, previous, target, date) {
    const day = chinaDay(date);
    const stats = await tx.get(COLLECTIONS.watch, statsId(uid));
    const scanQuota = await tx.get(COLLECTIONS.watch, scanQuotaId(uid, day));
    const isNewFollow = !ownedFollow(previous, uid);
    if (isNewFollow && (stats?.followCount ?? 0) >= 500) reject('FOLLOW_LIMIT', '最多同时追番 500 部，请先取消部分追番。');
    if (!target && (scanQuota?.count ?? 0) >= 20) reject('RATE_LIMITED', '今天已新增 20 个监控节目，请明天再添加；已监控的节目仍可追番。');
    return { day, stats, scanQuota, isNewFollow };
  }
  async function writeLimits(tx, uid, limits, target, series, official, at) {
    if (limits.isNewFollow) await tx.put(COLLECTIONS.watch, statsId(uid), { kind: 'stats', owner: uid, followCount: (limits.stats?.followCount ?? 0) + 1 });
    if (!target) {
      await tx.put(COLLECTIONS.watch, scanQuotaId(uid, limits.day), { kind: 'scan-quota', owner: uid, day: limits.day, count: (limits.scanQuota?.count ?? 0) + 1 });
      await tx.put(COLLECTIONS.targets, series.id, { id: series.id, seriesId: series.id, url: official.url, platform: official.platform, source: 'user', status: 'queued', nextScanAt: at, failureCount: 0 });
    } else if (target.source !== 'user') await tx.put(COLLECTIONS.targets, series.id, { ...target, source: 'user' });
  }
  function seriesIdFrom(payload) {
    if (typeof payload.seriesId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(payload.seriesId)) reject('INVALID_SERIES', '节目编号无效。');
    return payload.seriesId;
  }
  return async function handle(event, identity) {
    try {
      const uid = identity?.uid;
      if (typeof uid !== 'string' || !uid.trim() || uid.length > 256 || identity.isAnonymous === true) reject('UNAUTHENTICATED', '请先登录账号。');
      const payload = event?.payload ?? {};
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) reject('INVALID_REQUEST', '请求格式无效。');
      const date = new Date(now());
      const at = date.toISOString();
      let data;
      if (event?.action === 'library') {
        const records = await store.listFollows(uid);
        // Filter again at the service boundary, including when an adapter is misconfigured.
        const owned = records.filter((follow) => follow.owner === uid && follow.kind === 'follow');
        const series = (await Promise.all(owned.map((follow) => lookupSeries(follow.seriesId)))).filter(Boolean);
        data = {
          user: { uid, displayName: typeof identity.displayName === 'string' ? identity.displayName.slice(0, 80) : '我的账号', ...(typeof identity.avatarUrl === 'string' && identity.avatarUrl.startsWith('https://') ? { avatarUrl: identity.avatarUrl } : {}) },
          series: series.map(cleanSeries), follows: owned.map(cleanFollow),
        };
      } else if (event?.action === 'submit') {
        let official;
        try {
          if (typeof payload.url !== 'string' || payload.url.length > 2048) throw new Error('Invalid URL size');
          official = normalizeOfficialUrl(payload.url);
        } catch { reject('INVALID_URL', '请填写支持的平台官方节目详情或播放链接（最多 2048 字符）。'); }
        if (!isSupportedPlatform(official.platform)) reject('UNSUPPORTED_PLATFORM', '目前仅支持哔哩哔哩、腾讯视频和优酷。');
        const known = seedsByUrl.get(official.url);
        const seriesId = known?.id ?? official.id;
        data = await store.transaction(async (tx) => {
          const stored = await tx.get(COLLECTIONS.series, seriesId);
          const previous = await tx.get(COLLECTIONS.watch, followId(uid, seriesId));
          const quotaKey = quotaId(uid, chinaDay(date));
          const quota = await tx.get(COLLECTIONS.watch, quotaKey);
          const target = await tx.get(COLLECTIONS.targets, seriesId);
          const limits = await readLimits(tx, uid, previous, target, date);
          const isNew = !stored && !known;
          if (isNew && (quota?.count ?? 0) >= 10) reject('RATE_LIMITED', '今天已补录 10 部新动漫，请明天再试。');
          const series = { ...(stored ?? known ?? { id: seriesId, title: pendingSeriesTitle(official), platform: official.platform, url: official.url, cover: '', status: 'unknown', episodes: '待核验', events: [], checkedAt: at, source: official.url, metadataPending: true }), ...(!target ? { monitoring: 'queued', nextScanAt: at } : {}) };
          const follow = previous?.owner === uid && previous.kind === 'follow' ? normalizeEpisodeProgress(previous) : newFollow(uid, seriesId, at);
          if (!stored || !target) await tx.put(COLLECTIONS.series, seriesId, series);
          if (isNew) {
            await tx.put(COLLECTIONS.watch, quotaKey, { kind: 'quota', owner: uid, day: chinaDay(date), count: (quota?.count ?? 0) + 1 });
          }
          await writeLimits(tx, uid, limits, target, series, official, at);
          await tx.put(COLLECTIONS.watch, followId(uid, seriesId), follow);
          return { series: cleanSeries(series), follow: cleanFollow(follow) };
        });
      } else if (['follow', 'unfollow', 'progress', 'open'].includes(event?.action)) {
        const seriesId = seriesIdFrom(payload);
        data = await store.transaction(async (tx) => {
          const previous = await tx.get(COLLECTIONS.watch, followId(uid, seriesId));
          const series = await lookupSeries(seriesId, tx);
          if (event.action === 'unfollow') {
            if (ownedFollow(previous, uid)) {
              const stats = await tx.get(COLLECTIONS.watch, statsId(uid));
              await tx.remove(COLLECTIONS.watch, followId(uid, seriesId));
              await tx.put(COLLECTIONS.watch, statsId(uid), { kind: 'stats', owner: uid, followCount: Math.max(0, (stats?.followCount ?? 1) - 1) });
            }
            return { seriesId };
          }
          if (!series) reject('NOT_FOUND', '目录中没有这部动漫，请先补录官方链接。');
          if (event.action !== 'unfollow' && !isSupportedPlatform(series.platform)) reject('UNSUPPORTED_PLATFORM', '目前仅支持哔哩哔哩、腾讯视频和优酷。');
          if (event.action === 'follow') {
            const target = await tx.get(COLLECTIONS.targets, seriesId);
            const limits = await readLimits(tx, uid, previous, target, date);
            let official;
            try { official = normalizeOfficialUrl(series.url); } catch { reject('INVALID_URL', '这个节目暂时没有可监控的官网链接，请补录有效链接。'); }
            const follow = previous?.owner === uid && previous.kind === 'follow' ? normalizeEpisodeProgress(previous) : newFollow(uid, seriesId, at);
            const stored = await tx.get(COLLECTIONS.series, seriesId);
            if (!stored || !target) await tx.put(COLLECTIONS.series, seriesId, { ...series, ...(!target ? { monitoring: 'queued', nextScanAt: at } : {}) });
            await writeLimits(tx, uid, limits, target, series, official, at);
            await tx.put(COLLECTIONS.watch, followId(uid, seriesId), follow);
            return cleanFollow(follow);
          }
          requireOwned(previous, uid);
          if (event.action === 'open') {
            const follow = { ...normalizeEpisodeProgress(previous), lastOpenedAt: at };
            await tx.put(COLLECTIONS.watch, followId(uid, seriesId), follow);
            return cleanFollow(follow);
          }
          const { currentEpisode, episodeCompleted, paused, version } = payload;
          const latest = latestPublishedEpisode(series, date.getTime());
          if (!validEpisodeProgress(currentEpisode, episodeCompleted, latest) || typeof paused !== 'boolean' || !Number.isInteger(version) || version < 1) reject('INVALID_PROGRESS', '请填写有效的集数、是否看完和进度版本；集数不能超过官网已发布集数，0 集表示尚未开始。');
          if (version !== previous.version) reject('CONFLICT', '观看进度已在其他页面更新，请刷新后再保存。');
          const follow = { ...normalizeEpisodeProgress(previous), currentEpisode, episodeCompleted, paused, updatedAt: at, version: version + 1 };
          await tx.put(COLLECTIONS.watch, followId(uid, seriesId), follow);
          return cleanFollow(follow);
        });
      } else reject('INVALID_ACTION', '不支持这个操作。');
      return { ok: true, data };
    } catch (error) {
      if (error instanceof UserError) return { ok: false, error: { code: error.code, message: error.message } };
      if (error instanceof CommitUnconfirmedError) return { ok: false, error: { code: error.code, message: error.message } };
      return { ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: '云服务暂时不可用，请稍后重试。' } };
    }
  };
}
