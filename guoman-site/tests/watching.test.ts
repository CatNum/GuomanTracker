import test from "node:test";
import assert from "node:assert/strict";
import { filterFollowIds, latestPublishedEpisode, recommendedCandidate, sortFollowIds, watchingQueue } from "../lib/watching.ts";
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
  assert.deepEqual(result, { ready: [], caughtUp: [], unknown: [], thisWeek: [] });
});
test("本周更新统计使用北京时间自然周的已发布正片集数证据", () => {
  const at = Date.parse("2026-10-11T16:00:00.000Z"); // 北京时间周一 00:00
  const item = {
    ...anime("weekly"), latestEpisode: undefined, episodes: "待核验", events: [
      { at: at - 1, label: "第9集", published: true, delayed: false },
      { at, label: "第4集", published: true, delayed: false },
      { at: at + 1000, label: "第5集", published: true, delayed: false },
      { at: at + 2000, label: "第6集预告", published: true, delayed: false },
      { at: at + 3000, label: "第7集花絮", published: true, delayed: false },
      { at: at + 4000, label: "第8集", published: true, delayed: true },
      { at: at + 5000, label: "第10集", published: true, delayed: false },
    ],
  };
  const result = watchingQueue([item], [follow("weekly", 4)], at + 4500);
  assert.deepEqual(result.thisWeek.map((candidate) => candidate.series.id), ["weekly"]);
  assert.equal(result.thisWeek[0].weeklyEpisodes, 1);
  const completed = watchingQueue([item], [{ ...follow("weekly", 10), episodeCompleted: true }], at + 5000);
  assert.equal(completed.thisWeek.length, 0);
});
test("本周统计在北京时间周一零点切周，排期与未来事件不入统计", () => {
  const monday = Date.parse("2026-10-11T16:00:00.000Z");
  const weekly = {
    ...anime("weekly", "待核验"),
    latestEpisode: undefined,
    events: [
      { at: monday - 1, label: "第3集", published: true, delayed: false },
      { at: monday, label: "第4集", published: true, delayed: false },
      { at: monday + 1, label: "第5集", published: true, delayed: false },
    ],
  };
  const atBoundary = watchingQueue([weekly], [follow("weekly", 3)], monday);
  assert.equal(atBoundary.thisWeek[0].weeklyEpisodes, 1);
  const beforeFutureEvent = watchingQueue([weekly], [follow("weekly", 3)], monday);
  assert.equal(beforeFutureEvent.thisWeek.length, 1);
  const scheduledOnly = watchingQueue([{ ...anime("scheduled"), days: [1], time: "20:00" }], [follow("scheduled")], monday + 1);
  assert.equal(scheduledOnly.thisWeek.length, 0);
});
test("推荐按用户优先级选择唯一有可靠未看更新的作品", () => {
  const queue = watchingQueue([anime("a"), anime("b"), anime("c")], [follow("a"), follow("b"), follow("c")], now);
  assert.equal(recommendedCandidate(queue.ready, ["c", "b", "a"])?.series.id, "c");
  assert.equal(recommendedCandidate(queue.ready, ["missing"])?.series.id, "a");
});
test("推荐跳过已追平和暂停作品，但保留完结且尚有未看集数的作品", () => {
  const series = [
    { ...anime("caught"), status: "finished" },
    { ...anime("paused"), status: "finished" },
    { ...anime("finished-unwatched"), status: "finished" },
    { ...anime("finished-done"), status: "finished" },
  ];
  const follows = [
    { ...follow("caught", 12), episodeCompleted: true },
    { ...follow("paused"), paused: true },
    { ...follow("finished-unwatched", 11), episodeCompleted: false },
    { ...follow("finished-done", 12), episodeCompleted: true },
  ];
  const queue = watchingQueue(series, follows, now);
  assert.deepEqual(queue.ready.map((item) => item.series.id), ["finished-unwatched"]);
  assert.equal(recommendedCandidate(queue.ready, ["caught", "paused", "finished-unwatched", "finished-done"])?.series.id, "finished-unwatched");
});
test("追番排序支持完整名称拼音和编号稳定兜底，筛选保留隐藏顺序", () => {
  const follows = ["same-z", "cang-yuan", "cae", "same-a", "cba", "cang-lan"].map((id) => follow(id));
  const series = [
    { ...anime("same-z"), title: "重名" },
    { ...anime("cang-yuan"), title: "苍元图" },
    { ...anime("cae"), title: "cae" },
    { ...anime("same-a"), title: "重名" },
    { ...anime("cba"), title: "cba" },
    { ...anime("cang-lan"), title: "苍兰诀" },
  ];
  assert.deepEqual(sortFollowIds(follows, series, ["same-z", "cang-yuan", "cae", "same-a", "cba", "cang-lan"], "priority"), ["same-z", "cang-yuan", "cae", "same-a", "cba", "cang-lan"]);
  assert.deepEqual(sortFollowIds([follow("cba"), follow("cae")], series, [], "name"), ["cae", "cba"]);
  assert.deepEqual(sortFollowIds([follow("cang-yuan"), follow("cang-lan")], series, [], "name"), ["cang-lan", "cang-yuan"]);
  assert.deepEqual(sortFollowIds([follow("same-z"), follow("same-a")], series, [], "name"), ["same-a", "same-z"]);
  const queue = watchingQueue(series, follows, now);
  const filtered = filterFollowIds(follows, queue, "unwatched", []);
  assert.deepEqual(filtered, ["same-z", "cang-yuan", "cae", "same-a", "cba", "cang-lan"]);
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
