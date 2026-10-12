import test from "node:test";
import assert from "node:assert/strict";
import { latestPublishedEpisode, watchingQueue } from "../lib/watching.ts";
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
test("不支持的平台历史追番保留在库里但不进入观看推荐队列", () => {
  const result = watchingQueue(
    [{ ...anime("iqiyi"), platform: "iqiyi", url: "https://www.iqiyi.com/a_abc.html" }],
    [follow("iqiyi")],
    now,
  );
  assert.deepEqual(result, { ready: [], caughtUp: [], unknown: [] });
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
test("新目录节目只提交官方链接，不能把目录标题或集数写入补录", async () => {
  const fresh = {
    ...anime("b", "更新至5话"),
    url: "https://www.bilibili.com/bangumi/play/ss999999999",
  };
  let invocation: [string, Record<string, unknown>] | undefined;
  await followCatalogSeries(fresh, [anime("a")], async (action, payload) => {
    invocation = [action, payload];
  });
  assert.deepEqual(invocation, ["submit", { url: fresh.url }]);
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
