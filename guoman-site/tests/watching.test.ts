import test from "node:test";
import assert from "node:assert/strict";
import { latestPublishedEpisode, watchingQueue } from "../lib/watching.ts";
import { createLocalLibrary } from "../lib/local-library.ts";
import { consumeOAuthState } from "../lib/oauth-state.ts";
import {
  endCloudSession,
  followCatalogSeries,
} from "../lib/account-actions.ts";
import type { Anime } from "../lib/catalog.ts";

const now = Date.parse("2026-10-05T12:00:00+08:00");
const anime = (id: string, episodes = "更新至12话"): Anime => ({
  id,
  title: id,
  platform: "bilibili",
  url: "https://www.bilibili.com/bangumi/play/ss123",
  cover: "",
  status: "ongoing",
  episodes,
  checkedAt: new Date(now).toISOString(),
  source: "official",
  events: [],
});
const follow = (seriesId: string, watchedEpisode = 0) => ({
  seriesId,
  currentEpisode: watchedEpisode,
  episodeCompleted: watchedEpisode > 0,
  paused: false,
  version: 1,
  updatedAt: new Date(now).toISOString(),
});

test("已发布集数不把未来安排、预告或总集数当作更新", () => {
  assert.equal(
    latestPublishedEpisode(
      {
        ...anime("a", "全24集，更新至12集"),
        events: [
          {
            at: now + 10000,
            label: "第13集",
            published: false,
            delayed: false,
          },
        ],
      },
      now,
    ),
    12,
  );
  assert.equal(latestPublishedEpisode(anime("a", "预告 第13集"), now), null);
  assert.equal(latestPublishedEpisode(anime("a", "预计全24集"), now), null);
  assert.equal(
    latestPublishedEpisode(
      {
        ...anime("a", ""),
        events: [
          { at: now - 10, label: "第7话", published: true, delayed: false },
          { at: now + 10, label: "第8话", published: true, delayed: false },
        ],
      },
      now,
    ),
    7,
  );
});
test("通用观看队列区分未看、已追平、暂停和待核验", () => {
  const series = [anime("a"), anime("b"), anime("c"), anime("d", "")];
  const result = watchingQueue(
    series,
    [
      follow("a", 8),
      follow("b", 12),
      { ...follow("c"), paused: true },
      follow("d"),
    ],
    now,
  );
  assert.deepEqual(
    result.ready.map((x) => [x.series.id, x.nextEpisode, x.unwatched]),
    [["a", 9, 4]],
  );
  assert.deepEqual(
    result.caughtUp.map((x) => x.series.id),
    ["b"],
  );
  assert.deepEqual(
    result.unknown.map((x) => x.series.id),
    ["d"],
  );
});
test("续看优先；过期排期不假定已经上线", () => {
  const result = watchingQueue(
    [anime("a"), { ...anime("b"), checkedAt: "2026-08-01T00:00:00Z" }],
    [
      follow("a"),
      { ...follow("b"), currentEpisode: 1, episodeCompleted: false },
    ],
    now,
  );
  assert.equal(result.ready[0].series.id, "b");
  assert.equal(result.ready[0].stale, true);
  assert.equal(result.ready[0].latestEpisode, 12);
});
test("计划更新的任意前缀不被误读为现在可看", () => {
  for (const text of [
    "明天更新至13集",
    "即将更新至13集",
    "将更新至13集",
    "下月更新至13集",
    "明年更新至13集",
    "周六将更新至13集",
    "更新至13集预告",
  ])
    assert.equal(latestPublishedEpisode(anime("a", text), now), null, text);
  assert.equal(
    latestPublishedEpisode(anime("a", "全24集，更新至12集"), now),
    12,
  );
  assert.equal(latestPublishedEpisode(anime("a", "已更新至12集"), now), 12);
});
test("本机演示记录打开但不完成；进度与追番可持久化和移除", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const local = createLocalLibrary(storage, [anime("a")]);
  const state = await local.call("follow", { seriesId: "a" });
  await local.call("open", { seriesId: "a" });
  let library = await local.call("library", {});
  assert.equal(library.follows[0].currentEpisode, 0);
  assert.ok(library.follows[0].lastOpenedAt);
  await local.call("progress", {
    seriesId: "a",
    currentEpisode: 3,
    episodeCompleted: false,
    paused: false,
    version: state.version,
  });
  library = await createLocalLibrary(storage, [anime("a")]).call("library", {});
  assert.equal(library.follows[0].currentEpisode, 3);
  await assert.rejects(
    () =>
      local.call("progress", {
        seriesId: "a",
        currentEpisode: 4,
        episodeCompleted: true,
        paused: false,
        version: state.version,
      }),
    /版本|刷新/,
  );
  await local.call("unfollow", { seriesId: "a" });
  assert.equal((await local.call("library", {})).follows.length, 0);
});
test("OAuth state 一次性消费；缺失、过期和不匹配均拒绝", () => {
  const record = JSON.stringify({
    state: "random-state",
    createdAt: now - 1000,
  });
  assert.equal(consumeOAuthState(record, "random-state", now), true);
  assert.equal(consumeOAuthState(record, "forged", now), false);
  assert.equal(consumeOAuthState(null, "random-state", now), false);
  assert.equal(
    consumeOAuthState(record, "random-state", now + 11 * 60000),
    false,
  );
});
test("微信 SDK 返回退出错误时保留账号状态；成功才清除", async () => {
  let signedIn = true;
  await assert.rejects(
    () =>
      endCloudSession(
        { signOut: async () => ({ data: {}, error: { message: "offline" } }) },
        () => {
          signedIn = false;
        },
      ),
    /退出未完成/,
  );
  assert.equal(signedIn, true);
  await endCloudSession(
    { signOut: async () => ({ data: {}, error: null }) },
    () => {
      signedIn = false;
    },
  );
  assert.equal(signedIn, false);
});
test("日历新增节目可以追番，未经服务器核验的集数不直接进入已更新列表", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const local = createLocalLibrary(storage, [anime("a")]);
  const fresh = {
    ...anime("b", "更新至5话"),
    url: "https://www.bilibili.com/bangumi/play/ss999999999",
  };
  await followCatalogSeries(fresh, [anime("a")], (action, payload) =>
    local.call(action, payload),
  );
  const library = await local.call("library", {});
  assert.equal(library.follows.length, 1);
  assert.equal(library.series[0].monitoring, "queued");
  assert.equal(latestPublishedEpisode(library.series[0], now), null);
});

test("最新一集未看完仍可续看，标为看完后才追平", () => {
  const state = { ...follow("a", 12), episodeCompleted: false };
  const unfinished = watchingQueue([anime("a")], [state], now);
  assert.equal(unfinished.ready[0].nextEpisode, 12);
  assert.equal(unfinished.ready[0].unwatched, 1);
  assert.equal(unfinished.caughtUp.length, 0);
  const completed = watchingQueue(
    [anime("a")],
    [{ ...state, episodeCompleted: true }],
    now,
  );
  assert.equal(completed.ready.length, 0);
  assert.equal(completed.caughtUp[0].nextEpisode, 13);
});

test("本机旧秒数记录转成下一集未看完；保存后仅保留集数状态", async () => {
  let saved = JSON.stringify({
    user: { uid: "local-demo", displayName: "本机演示" },
    series: [anime("a")],
    follows: [
      {
        seriesId: "a",
        watchedEpisode: 3,
        positionSeconds: 90,
        paused: false,
        version: 1,
        updatedAt: new Date(now).toISOString(),
      },
    ],
  });
  const storage = {
    getItem: () => saved,
    setItem: (_key: string, value: string) => {
      saved = value;
    },
  };
  const local = createLocalLibrary(storage, []);
  const state = (await local.call("library", {})).follows[0];
  assert.equal(state.currentEpisode, 4);
  assert.equal(state.episodeCompleted, false);
  await local.call("progress", {
    seriesId: "a",
    currentEpisode: 4,
    episodeCompleted: true,
    paused: false,
    version: 1,
  });
  const persisted = JSON.parse(saved).follows[0];
  assert.equal(persisted.currentEpisode, 4);
  assert.equal(persisted.episodeCompleted, true);
  assert.equal("positionSeconds" in persisted, false);
  assert.equal("watchedEpisode" in persisted, false);
});

test("本机拒绝零集已看完、无效完成状态和超出已发布的集数", async () => {
  let saved: string | null = null;
  const local = createLocalLibrary(
    {
      getItem: () => saved,
      setItem: (_key: string, value: string) => {
        saved = value;
      },
    },
    [anime("a")],
  );
  await local.call("follow", { seriesId: "a" });
  const payload = {
    seriesId: "a",
    currentEpisode: 1,
    episodeCompleted: false,
    paused: false,
    version: 1,
  };
  for (const patch of [
    { currentEpisode: 0, episodeCompleted: true },
    { currentEpisode: 13 },
    { episodeCompleted: "yes" },
    { currentEpisode: 1.5 },
  ]) {
    await assert.rejects(() =>
      local.call("progress", { ...payload, ...patch }),
    );
  }
  await local.call("progress", payload);
  assert.equal(
    (await local.call("library", {})).follows[0].episodeCompleted,
    false,
  );
});
