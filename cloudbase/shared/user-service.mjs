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
const titleCollator = new Intl.Collator('zh-CN-u-co-pinyin', { sensitivity: 'base' });
const compareIds = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const chinaDay = (date) => new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
class UserError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const reject = (code, message) => { throw new UserError(code, message); };
const cleanFollow = ({ owner, kind, _id, ...follow }) => normalizeEpisodeProgress(follow);
const cleanSeries = ({ _id, submittedBy, ...series }) => series;

/** Creates the authenticated domain service. Identity is supplied by the trusted cloud-function entry, never by event data. */
export function createUserService({ store, now = () => new Date(), resolveMetadata }) {
  async function lookupSeries(id, boundary = store) {
    return await boundary.get(COLLECTIONS.series, id);
  }
  async function legacyFollowSnapshot(uid, knownStats) {
    const stats = knownStats === undefined ? await store.get(COLLECTIONS.watch, statsId(uid)) : knownStats;
    const needsOrder = !Array.isArray(stats?.priorityOrder);
    const needsCount = !Number.isSafeInteger(stats?.followCount) || stats.followCount < 0;
    if (!needsOrder && !needsCount) return null;
    const existing = (await store.listFollows(uid)).filter((follow) => follow.owner === uid && follow.kind === 'follow');
    let order = null;
    if (needsOrder) {
      const titles = await Promise.all(existing.map(async (follow) => [follow.seriesId, await lookupSeries(follow.seriesId)]));
      const titleById = new Map(titles.map(([id, series]) => [id, series?.title || '']));
      order = [...new Set(existing.map((follow) => follow.seriesId))].sort((a, b) => titleCollator.compare(titleById.get(a), titleById.get(b)) || compareIds(a, b));
    }
    return { order, followCount: needsCount ? existing.length : stats.followCount };
  }
  const resolveInFlight = new Map();
  const hasConfirmedTitle = (series, official) => typeof series?.title === 'string'
    && Boolean(series.title.trim()) && series.metadataPending !== true
    && series.title !== pendingSeriesTitle(official);
  async function resolveNewMetadata(official) {
    if (typeof resolveMetadata !== 'function') return null;
    if (!resolveInFlight.has(official.id)) {
      const pending = Promise.resolve().then(() => resolveMetadata(official)).finally(() => resolveInFlight.delete(official.id));
      resolveInFlight.set(official.id, pending);
    }
    try {
      const metadata = await resolveInFlight.get(official.id);
      if (!metadata || typeof metadata.title !== 'string' || !metadata.title.trim()) return null;
      const title = metadata.title.trim().slice(0, 120);
      const cover = typeof metadata.cover === 'string' && metadata.cover.startsWith('https://') ? metadata.cover.slice(0, 2048) : '';
      return { title, cover };
    } catch { return null; }
  }
  const membershipVersion = (stats) => Number.isSafeInteger(stats?.membershipVersion) && stats.membershipVersion >= 0 ? stats.membershipVersion : 0;
  const orderVersion = (stats) => Number.isSafeInteger(stats?.orderVersion) && stats.orderVersion >= 0 ? stats.orderVersion : 0;
  const validOrder = (order) => Array.isArray(order) ? order.filter((id) => typeof id === 'string') : [];
  function newFollow(uid, seriesId, at) {
    return { owner: uid, kind: 'follow', seriesId, currentEpisode: 0, episodeCompleted: false, paused: false, updatedAt: at, version: 1 };
  }
  function requireOwned(follow, uid) {
    if (!follow || follow.owner !== uid || follow.kind !== 'follow') reject('NOT_FOLLOWING', '请先追番，再记录观看进度。');
  }
  const ownedFollow = (follow, uid) => follow?.owner === uid && follow.kind === 'follow';
  async function readLimits(tx, uid, previous, target, date, legacyFollowCount = 0, known) {
    const day = chinaDay(date);
    const [stats, scanQuota] = known ? [known.stats, known.scanQuota] : await Promise.all([
      tx.get(COLLECTIONS.watch, statsId(uid)), tx.get(COLLECTIONS.watch, scanQuotaId(uid, day)),
    ]);
    const isNewFollow = !ownedFollow(previous, uid);
    const followCount = stats?.followCount ?? legacyFollowCount;
    if (isNewFollow && followCount >= 500) reject('FOLLOW_LIMIT', '最多同时追番 500 部，请先取消部分追番。');
    if (!target && (scanQuota?.count ?? 0) >= 20) reject('RATE_LIMITED', '今天已新增 20 个监控节目，请明天再添加；已监控的节目仍可追番。');
    return { day, stats, scanQuota, isNewFollow };
  }
  async function writeLimits(tx, uid, limits, target, series, official, at) {
    let nextStats = limits.stats;
    if (limits.isNewFollow) {
      const previousOrder = Array.isArray(limits.stats?.priorityOrder) ? validOrder(limits.stats.priorityOrder) : (limits.legacyOrder || []);
      const priorityOrder = previousOrder.includes(series.id) ? previousOrder : [...previousOrder, series.id];
      nextStats = {
        ...(limits.stats ?? {}), kind: 'stats', owner: uid,
        followCount: (limits.stats?.followCount ?? limits.legacyFollowCount ?? 0) + 1,
        priorityOrder,
        membershipVersion: membershipVersion(limits.stats) + 1,
        orderVersion: orderVersion(limits.stats),
      };
      await tx.put(COLLECTIONS.watch, statsId(uid), nextStats);
    }
    if (!target) {
      await tx.put(COLLECTIONS.watch, scanQuotaId(uid, limits.day), { kind: 'scan-quota', owner: uid, day: limits.day, count: (limits.scanQuota?.count ?? 0) + 1 });
      await tx.put(COLLECTIONS.targets, series.id, { id: series.id, seriesId: series.id, url: official.url, platform: official.platform, source: 'user', status: 'queued', nextScanAt: at, failureCount: 0 });
    } else if (target.source !== 'user') await tx.put(COLLECTIONS.targets, series.id, { ...target, source: 'user' });
    return nextStats;
  }
  function libraryPatch(before, after) {
    return { beforeMembershipVersion: membershipVersion(before), beforeOrderVersion: orderVersion(before),
      membershipVersion: membershipVersion(after), orderVersion: orderVersion(after), priorityOrder: validOrder(after?.priorityOrder) };
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
        let snapshot;
        for (let attempt = 0; attempt < 3; attempt++) {
          const before = await store.get(COLLECTIONS.watch, statsId(uid));
          const records = await store.listFollows(uid);
          const after = await store.get(COLLECTIONS.watch, statsId(uid));
          if (membershipVersion(before) === membershipVersion(after)) {
            snapshot = { records, stats: after };
            break;
          }
        }
        if (!snapshot) reject('CONFLICT', '追番列表正在变化，请刷新后重试。');
        // Filter again at the service boundary, including when an adapter is misconfigured.
        const owned = snapshot.records.filter((follow) => follow.owner === uid && follow.kind === 'follow');
        const seriesIds = new Set(owned.map((follow) => follow.seriesId));
        const storedOrder = [...new Set(validOrder(snapshot.stats?.priorityOrder))].filter((id) => seriesIds.has(id));
        const series = (await Promise.all(owned.map((follow) => lookupSeries(follow.seriesId)))).filter(Boolean);
        const titleById = new Map(series.map((item) => [item.id, item.title]));
        const priorityOrder = [...storedOrder, ...[...seriesIds].filter((id) => !storedOrder.includes(id)).sort((a, b) => titleCollator.compare(titleById.get(a) || '', titleById.get(b) || '') || compareIds(a, b))];
        data = {
          user: { uid, displayName: typeof identity.displayName === 'string' ? identity.displayName.slice(0, 80) : '我的账号', ...(typeof identity.avatarUrl === 'string' && identity.avatarUrl.startsWith('https://') ? { avatarUrl: identity.avatarUrl } : {}) },
          series: series.map(cleanSeries), follows: owned.map(cleanFollow), priorityOrder,
          membershipVersion: membershipVersion(snapshot.stats), orderVersion: orderVersion(snapshot.stats),
        };
      } else if (event?.action === 'submit') {
        let official;
        try {
          if (typeof payload.url !== 'string' || payload.url.length > 2048) throw new Error('Invalid URL size');
          official = normalizeOfficialUrl(payload.url);
        } catch { reject('INVALID_URL', '请填写支持的平台官方节目详情或播放链接（最多 2048 字符）。'); }
        if (!isSupportedPlatform(official.platform)) reject('UNSUPPORTED_PLATFORM', '目前仅支持哔哩哔哩、腾讯视频和优酷。');
        const known = await store.findSeriesByUrl(official.url);
        const seriesId = known?.id ?? official.id;
        const existingBeforeTransaction = known ? null : await store.get(COLLECTIONS.series, seriesId);
        const isNewBeforeTransaction = !known && !existingBeforeTransaction;
        const keyDay = chinaDay(date);
        const [statsBefore, previousBefore, targetBefore, quotaBefore, scanQuotaBefore] = await Promise.all([
          store.get(COLLECTIONS.watch, statsId(uid)),
          store.get(COLLECTIONS.watch, followId(uid, seriesId)),
          store.get(COLLECTIONS.targets, seriesId),
          store.get(COLLECTIONS.watch, quotaId(uid, keyDay)),
          store.get(COLLECTIONS.watch, scanQuotaId(uid, keyDay)),
        ]);
        if (isNewBeforeTransaction && (quotaBefore?.count ?? 0) >= 10) reject('RATE_LIMITED', '今天已补录 10 部新动漫，请明天再试。');
        if (!targetBefore && (scanQuotaBefore?.count ?? 0) >= 20) reject('RATE_LIMITED', '今天已新增 20 个监控节目，请明天再添加；已监控的节目仍可追番。');
        let legacySnapshot = null;
        if (!Number.isSafeInteger(statsBefore?.followCount) || statsBefore.followCount < 0 || !Array.isArray(statsBefore?.priorityOrder))
          legacySnapshot = await legacyFollowSnapshot(uid, statsBefore);
        const followCountBefore = Number.isSafeInteger(statsBefore?.followCount) && statsBefore.followCount >= 0
          ? statsBefore.followCount
          : legacySnapshot?.followCount ?? 0;
        if (!ownedFollow(previousBefore, uid) && followCountBefore >= 500) reject('FOLLOW_LIMIT', '最多同时追番 500 部，请先取消部分追番。');
        const needsMetadata = !hasConfirmedTitle(known ?? existingBeforeTransaction, official);
        const resolvedMetadata = needsMetadata ? await resolveNewMetadata(official) : null;
        const metadataFailure = () => reject('METADATA_UNAVAILABLE', '补录失败：未能识别官方节目名称，本次未保存任何更改。请稍后重试或使用该节目的其他官方链接。');
        if (needsMetadata && !resolvedMetadata) metadataFailure();
        if (!legacySnapshot) legacySnapshot = await legacyFollowSnapshot(uid, statsBefore);
        data = await store.transaction(async (tx) => {
          const stored = await tx.get(COLLECTIONS.series, seriesId);
          const previous = await tx.get(COLLECTIONS.watch, followId(uid, seriesId));
          const quotaKey = quotaId(uid, chinaDay(date));
          const quota = await tx.get(COLLECTIONS.watch, quotaKey);
          const target = await tx.get(COLLECTIONS.targets, seriesId);
          const limits = await readLimits(tx, uid, previous, target, date, legacySnapshot?.followCount ?? 0);
          limits.legacyOrder = legacySnapshot?.order ?? null;
          limits.legacyFollowCount = legacySnapshot?.followCount ?? 0;
          const isNew = !stored && !known;
          if (isNew && (quota?.count ?? 0) >= 10) reject('RATE_LIMITED', '今天已补录 10 部新动漫，请明天再试。');
          const existing = stored ?? known;
          const needsRepair = !hasConfirmedTitle(existing, official);
          if (needsRepair && !resolvedMetadata) metadataFailure();
          const series = {
            ...(existing ?? { id: seriesId, platform: official.platform, url: official.url, cover: '', status: 'unknown', episodes: '待核验', events: [], checkedAt: at, source: official.url }),
            ...(needsRepair ? { ...resolvedMetadata, metadataPending: false } : {}),
            ...(!target ? { monitoring: 'queued', nextScanAt: at } : {}),
          };
          const follow = previous?.owner === uid && previous.kind === 'follow' ? normalizeEpisodeProgress(previous) : newFollow(uid, seriesId, at);
          if (!stored || !target || needsRepair) await tx.put(COLLECTIONS.series, seriesId, series);
          if (isNew) {
            await tx.put(COLLECTIONS.watch, quotaKey, { kind: 'quota', owner: uid, day: chinaDay(date), count: (quota?.count ?? 0) + 1 });
          }
          await writeLimits(tx, uid, limits, target, series, official, at);
          await tx.put(COLLECTIONS.watch, followId(uid, seriesId), follow);
          return { series: cleanSeries(series), follow: cleanFollow(follow) };
        });
      } else if (event?.action === 'reorder') {
        const expectedMembershipVersion = payload.expectedMembershipVersion;
        const expectedOrderVersion = payload.expectedOrderVersion;
        const seriesIds = payload.seriesIds;
        if (!Array.isArray(seriesIds) || seriesIds.length > 500 || seriesIds.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/u.test(id)) || new Set(seriesIds).size !== seriesIds.length || !Number.isSafeInteger(expectedMembershipVersion) || expectedMembershipVersion < 0 || !Number.isSafeInteger(expectedOrderVersion) || expectedOrderVersion < 0) reject('INVALID_ORDER', '追番顺序无效，请刷新后重试。');
        const initialStats = await store.get(COLLECTIONS.watch, statsId(uid));
        const baselineMembershipVersion = membershipVersion(initialStats);
        const records = await store.listFollows(uid);
        const owned = records.filter((follow) => follow.owner === uid && follow.kind === 'follow');
        const actualIds = [...new Set(owned.map((follow) => follow.seriesId))];
        if (actualIds.length !== owned.length || seriesIds.length !== actualIds.length || seriesIds.some((id) => !actualIds.includes(id))) reject('INVALID_ORDER', '排序必须包含本人全部追番且每部仅出现一次。');
        data = await store.transaction(async (tx) => {
          const stats = await tx.get(COLLECTIONS.watch, statsId(uid));
          const currentMembershipVersion = membershipVersion(stats);
          const currentOrderVersion = orderVersion(stats);
          if (baselineMembershipVersion !== currentMembershipVersion || baselineMembershipVersion !== expectedMembershipVersion || currentOrderVersion !== expectedOrderVersion) reject('CONFLICT', '追番成员或优先级顺序已经变化，请刷新后重试。');
          const nextStats = {
            ...(stats ?? {}), kind: 'stats', owner: uid,
            followCount: stats?.followCount ?? actualIds.length,
            priorityOrder: seriesIds,
            membershipVersion: currentMembershipVersion,
            orderVersion: currentOrderVersion + 1,
          };
          await tx.put(COLLECTIONS.watch, statsId(uid), nextStats);
          return { priorityOrder: seriesIds, membershipVersion: currentMembershipVersion, orderVersion: nextStats.orderVersion };
        });
      } else if (['follow', 'unfollow', 'progress', 'open'].includes(event?.action)) {
        const seriesId = seriesIdFrom(payload);
        data = await store.transaction(async (tx) => {
          const membershipAction = ['follow', 'unfollow'].includes(event.action);
          const [previous, series, stats, target, scanQuota] = await Promise.all([
            tx.get(COLLECTIONS.watch, followId(uid, seriesId)),
            event.action === 'unfollow' ? null : lookupSeries(seriesId, tx),
            membershipAction ? tx.get(COLLECTIONS.watch, statsId(uid)) : null,
            event.action === 'follow' ? tx.get(COLLECTIONS.targets, seriesId) : null,
            event.action === 'follow' ? tx.get(COLLECTIONS.watch, scanQuotaId(uid, chinaDay(date))) : null,
          ]);
          const legacySnapshot = membershipAction ? await legacyFollowSnapshot(uid, stats) : null;
          if (event.action === 'unfollow') {
            let nextStats = stats;
            if (ownedFollow(previous, uid)) {
              await tx.remove(COLLECTIONS.watch, followId(uid, seriesId));
              nextStats = {
                ...(stats ?? {}), kind: 'stats', owner: uid,
                followCount: Math.max(0, (stats?.followCount ?? legacySnapshot?.followCount ?? 1) - 1),
                priorityOrder: (Array.isArray(stats?.priorityOrder) ? validOrder(stats.priorityOrder) : (legacySnapshot?.order || [])).filter((id) => id !== seriesId),
                membershipVersion: membershipVersion(stats) + 1,
                orderVersion: orderVersion(stats),
              };
              await tx.put(COLLECTIONS.watch, statsId(uid), nextStats);
            }
            return { seriesId, libraryPatch: libraryPatch(stats, nextStats) };
          }
          if (!series) reject('NOT_FOUND', '目录中没有这部动漫，请先补录官方链接。');
          if (event.action !== 'unfollow' && !isSupportedPlatform(series.platform)) reject('UNSUPPORTED_PLATFORM', '目前仅支持哔哩哔哩、腾讯视频和优酷。');
          if (event.action === 'follow') {
            const limits = await readLimits(tx, uid, previous, target, date, legacySnapshot?.followCount ?? 0, { stats, scanQuota });
            limits.legacyOrder = legacySnapshot?.order ?? null;
            limits.legacyFollowCount = legacySnapshot?.followCount ?? 0;
            let official;
            try { official = normalizeOfficialUrl(series.url); } catch { reject('INVALID_URL', '这个节目暂时没有可监控的官网链接，请补录有效链接。'); }
            const follow = previous?.owner === uid && previous.kind === 'follow' ? normalizeEpisodeProgress(previous) : newFollow(uid, seriesId, at);
            const stored = await tx.get(COLLECTIONS.series, seriesId);
            const confirmedSeries = { ...series, ...(!target ? { monitoring: 'queued', nextScanAt: at } : {}) };
            if (!stored || !target) await tx.put(COLLECTIONS.series, seriesId, confirmedSeries);
            const nextStats = await writeLimits(tx, uid, limits, target, series, official, at);
            await tx.put(COLLECTIONS.watch, followId(uid, seriesId), follow);
            return { ...cleanFollow(follow), series: cleanSeries(confirmedSeries), libraryPatch: libraryPatch(stats, nextStats) };
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
