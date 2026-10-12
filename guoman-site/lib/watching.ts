import type { Anime } from "./catalog.ts";
import { latestPublishedEpisode } from "../../cloudbase/shared/published-episode.mjs";
import { completedEpisodeCount } from "../../cloudbase/shared/episode-progress.mjs";
import { isSupportedPlatform } from "../../cloudbase/shared/platform-support.mjs";
export { latestPublishedEpisode };

export type WatchState = {
  seriesId: string;
  currentEpisode: number;
  episodeCompleted: boolean;
  paused: boolean;
  updatedAt: string;
  lastOpenedAt?: string;
  version: number;
};
export type UserProfile = {
  uid: string;
  displayName: string;
  avatarUrl?: string;
};
export type Library = {
  user: UserProfile;
  series: Anime[];
  follows: WatchState[];
  priorityOrder: string[];
  membershipVersion: number;
  orderVersion: number;
};
export type WatchCandidate = {
  series: Anime;
  follow: WatchState;
  latestEpisode: number | null;
  nextEpisode: number;
  unwatched: number;
  stale: boolean;
  weeklyEpisodes: number;
};

export type WatchFilter = "all" | "week" | "unwatched" | "active" | "caught-up";
export type FollowSort = "priority" | "name";
const nameCollator = new Intl.Collator("zh-CN-u-co-pinyin", { sensitivity: "base" });
const compareIds = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function completedCount(follow: WatchState): number {
  return completedEpisodeCount(follow);
}

function weekBoundsBeijing(now: number): [number, number] {
  const beijing = new Date(now + 8 * 60 * 60 * 1000);
  const weekday = beijing.getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  const start = Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth(), beijing.getUTCDate() - daysSinceMonday) - 8 * 60 * 60 * 1000;
  return [start, start + 7 * 24 * 60 * 60 * 1000];
}

function weeklyUnwatchedEpisodes(series: Anime, follow: WatchState, now: number): number {
  const [start, end] = weekBoundsBeijing(now);
  const completed = completedCount(follow);
  const episodes = new Set<number>();
  for (const event of series.events || []) {
    if (event.published !== true || event.delayed !== false || !Number.isFinite(event.at) || event.at < start || event.at >= end || event.at > now) continue;
    if (/预告|花絮|特辑|PV|CM|先导|敬请|即将|预约/u.test(event.label)) continue;
    const match = String(event.label || "").match(/(?:第\s*)?(\d{1,5})\s*[集话](?!全)/u);
    if (match) {
      const episode = Number(match[1]);
      if (episode > completed) episodes.add(episode);
    }
  }
  return episodes.size;
}

/** 按用户的未看和续看状态，组织通用观看入口。 */
export function watchingQueue(
  series: Anime[],
  follows: WatchState[],
  now = Date.now(),
) {
  const byId = new Map(series.map((s) => [s.id, s]));
  const ready: WatchCandidate[] = [],
    caughtUp: WatchCandidate[] = [],
    unknown: WatchCandidate[] = [],
    thisWeek: WatchCandidate[] = [];
  for (const follow of follows) {
    const item = byId.get(follow.seriesId);
    if (!item || !isSupportedPlatform(item.platform) || follow.paused) continue;
    const latestEpisode = latestPublishedEpisode(item, now);
    const candidate = {
      series: item,
      follow,
      latestEpisode,
      nextEpisode: Math.max(
        1,
        follow.currentEpisode + Number(follow.episodeCompleted),
      ),
      unwatched: Math.max(
        0,
        (latestEpisode ?? completedEpisodeCount(follow)) -
          completedEpisodeCount(follow),
      ),
      weeklyEpisodes: weeklyUnwatchedEpisodes(item, follow, now),
      stale: now - Date.parse(item.lastScanAt || item.checkedAt) > 2 * 86400000,
    };
    if (candidate.weeklyEpisodes > 0) thisWeek.push(candidate);
    if (latestEpisode === null) unknown.push(candidate);
    else if (candidate.unwatched > 0) ready.push(candidate);
    else caughtUp.push(candidate);
  }
  ready.sort(
    (a, b) =>
      Number(b.follow.currentEpisode > 0 && !b.follow.episodeCompleted) -
        Number(a.follow.currentEpisode > 0 && !a.follow.episodeCompleted) ||
      Date.parse(b.series.lastScanAt || b.series.checkedAt) -
        Date.parse(a.series.lastScanAt || a.series.checkedAt) ||
      nameCollator.compare(a.series.title, b.series.title) || compareIds(a.series.id, b.series.id),
  );
  thisWeek.sort((a, b) => nameCollator.compare(a.series.title, b.series.title) || compareIds(a.series.id, b.series.id));
  return { ready, caughtUp, unknown, thisWeek };
}

/** Choose one available recommendation by the persisted complete user order. */
export function recommendedCandidate(ready: WatchCandidate[], priorityOrder: string[]): WatchCandidate | null {
  if (!ready.length) return null;
  const priority = new Map(priorityOrder.map((id, index) => [id, index]));
  return [...ready].sort((a, b) =>
    (priority.get(a.series.id) ?? Number.MAX_SAFE_INTEGER) - (priority.get(b.series.id) ?? Number.MAX_SAFE_INTEGER) ||
    Number(b.follow.currentEpisode > 0 && !b.follow.episodeCompleted) - Number(a.follow.currentEpisode > 0 && !a.follow.episodeCompleted) ||
    nameCollator.compare(a.series.title, b.series.title) || compareIds(a.series.id, b.series.id),
  )[0];
}

/** Sort every follow ID, keeping stored order first and appending legacy omissions by pinyin name. */
export function sortFollowIds(follows: WatchState[], series: Anime[], priorityOrder: string[], sort: FollowSort): string[] {
  const ids = [...new Set(follows.map((follow) => follow.seriesId))];
  const byId = new Map(series.map((item) => [item.id, item]));
  if (sort === "name") return ids.sort((a, b) => nameCollator.compare(byId.get(a)?.title || "", byId.get(b)?.title || "") || compareIds(a, b));
  const members = new Set(ids);
  const ordered = [...new Set(priorityOrder)].filter((id) => members.has(id));
  const missing = ids.filter((id) => !ordered.includes(id)).sort((a, b) => nameCollator.compare(byId.get(a)?.title || "", byId.get(b)?.title || "") || compareIds(a, b));
  return [...ordered, ...missing];
}

/** Filter visible list IDs without changing the full priority order. */
export function filterFollowIds(follows: WatchState[], queue: ReturnType<typeof watchingQueue>, filter: WatchFilter, thisWeekIds: string[]): string[] {
  if (filter === "all") return follows.map((follow) => follow.seriesId);
  const included = new Set(
    filter === "week" ? thisWeekIds :
    filter === "unwatched" ? queue.ready.map((candidate) => candidate.series.id) :
    filter === "caught-up" ? queue.caughtUp.map((candidate) => candidate.series.id) :
    follows.filter((follow) => !follow.paused).map((follow) => follow.seriesId),
  );
  return follows.filter((follow) => included.has(follow.seriesId)).map((follow) => follow.seriesId);
}
