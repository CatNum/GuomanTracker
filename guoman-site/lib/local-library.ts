import type { Anime } from "./catalog.ts";
import {
  latestPublishedEpisode,
  type Library,
  type WatchState,
} from "./watching.ts";
import { parseOfficialUrl } from "../../cloudbase/shared/official-url.mjs";
import {
  normalizeEpisodeProgress,
  validEpisodeProgress,
} from "../../cloudbase/shared/episode-progress.mjs";

const key = "guoman-device-library-v2";
type StoragePort = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};
/** 明确选择的本机演示；云服务异常时不自动启用。 */
export function createLocalLibrary(storage: StoragePort, catalog: Anime[]) {
  function read(): Library {
    try {
      const data = JSON.parse(storage.getItem(key) || "null");
      if (data && Array.isArray(data.series) && Array.isArray(data.follows))
        return { ...data, follows: data.follows.map(normalizeEpisodeProgress) };
    } catch {}
    return {
      user: { uid: "local-demo", displayName: "本机演示" },
      series: [],
      follows: [],
    };
  }
  return {
    async call(action: string, payload: Record<string, unknown>): Promise<any> {
      const library = read(),
        now = new Date().toISOString();
      let result: any;
      if (action === "library") return library;
      const seriesId = String(payload.seriesId || "");
      let state = library.follows.find((x) => x.seriesId === seriesId);
      if (action === "follow") {
        const series =
          catalog.find((x) => x.id === seriesId) ||
          library.series.find((x) => x.id === seriesId);
        if (!series) throw new Error("未找到这部动漫");
        if (!library.series.some((x) => x.id === seriesId))
          library.series.push(series);
        if (!state) {
          state = {
            seriesId,
            currentEpisode: 0,
            episodeCompleted: false,
            paused: false,
            updatedAt: now,
            version: 1,
          };
          library.follows.push(state);
        }
        result = state;
      } else if (action === "submit") {
        const title = String(payload.title || "").trim(),
          url = parseOfficialUrl(String(payload.url || ""));
        if (!title || title.length > 100)
          throw new Error("请填写 1–100 字的动漫名称");
        let series = [...catalog, ...library.series].find(
          (x) => x.url === url.url,
        );
        if (!series) {
          series = {
            id: "local-" + encodeURIComponent(url.url),
            title,
            platform: url.platform,
            url: url.url,
            cover: "",
            episodes: "",
            status: "unknown",
            checkedAt: now,
            source: "user",
            events: [],
            monitoring: "queued",
          };
          library.series.push(series);
        }
        const follow = library.follows.find(
          (x) => x.seriesId === series!.id,
        ) || {
          seriesId: series.id,
          currentEpisode: 0,
          episodeCompleted: false,
          paused: false,
          updatedAt: now,
          version: 1,
        };
        if (!library.series.some((x) => x.id === series!.id))
          library.series.push(series);
        if (!library.follows.includes(follow)) library.follows.push(follow);
        result = { series, follow };
      } else if (action === "unfollow") {
        library.follows = library.follows.filter(
          (x) => x.seriesId !== seriesId,
        );
        result = { seriesId };
      } else if (action === "progress" || action === "open") {
        if (!state) throw new Error("请先追番");
        if (action === "open") {
          state.lastOpenedAt = now;
          result = state;
        } else {
          if (payload.version !== state.version)
            throw new Error("观看记录版本已变化，请刷新后重试");
          const episode = payload.currentEpisode;
          const latest = latestPublishedEpisode(
            library.series.find((x) => x.id === seriesId)!,
          );
          if (
            !validEpisodeProgress(episode, payload.episodeCompleted, latest) ||
            typeof payload.paused !== "boolean"
          )
            throw new Error("请检查集数和是否看完；0 集表示尚未开始");
          Object.assign(state, {
            currentEpisode: episode,
            episodeCompleted: payload.episodeCompleted,
            paused: payload.paused,
            updatedAt: now,
            version: state.version + 1,
          });
          result = state;
        }
      } else throw new Error("未知操作");
      storage.setItem(key, JSON.stringify(library));
      return result;
    },
  };
}
