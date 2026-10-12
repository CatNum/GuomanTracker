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
};
export type WatchCandidate = {
  series: Anime;
  follow: WatchState;
  latestEpisode: number | null;
  nextEpisode: number;
  unwatched: number;
  stale: boolean;
};

/** 按用户的未看和续看状态，组织通用观看入口。 */
export function watchingQueue(
  series: Anime[],
  follows: WatchState[],
  now = Date.now(),
) {
  const byId = new Map(series.map((s) => [s.id, s]));
  const ready: WatchCandidate[] = [],
    caughtUp: WatchCandidate[] = [],
    unknown: WatchCandidate[] = [];
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
      stale: now - Date.parse(item.lastScanAt || item.checkedAt) > 2 * 86400000,
    };
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
      a.series.title.localeCompare(b.series.title, "zh-CN"),
  );
  return { ready, caughtUp, unknown };
}
