import assert from "node:assert/strict";
import test from "node:test";
import type { Anime } from "../lib/catalog.ts";
import { followedCatalog } from "../lib/personal-catalog.ts";
import { weeklySchedule } from "../lib/weekly-schedule.ts";
import { validSchedule } from "../lib/catalog.ts";

const series: Anime = { id: "followed", title: "已追番", platform: "bilibili", url: "https://www.bilibili.com/", cover: "", status: "ongoing", episodes: "第 2 集", checkedAt: "2026-10-12", source: "official", events: [] };

test("personal catalog never includes unfollowed titles or falls back to all titles for an empty account", () => {
  const items = [series, { ...series, id: "other" }];
  assert.deepEqual(followedCatalog(items, [], ["followed"]).map(a => a.id), ["followed"]);
  assert.deepEqual(followedCatalog(items, [], []), []);
  assert.deepEqual(followedCatalog(items, [], ["missing"]), []);
});

test("personal submissions survive catalog refresh and stale snapshots cannot replace newer account metadata", () => {
  const custom = { ...series, id: "custom", title: "补录作品" };
  const stale = { ...series, checkedAt: "2026-10-01", episodes: "第 1 集" };
  const result = followedCatalog([stale], [series, custom], ["followed", "custom"]);
  assert.deepEqual(result.map(a => [a.id, a.episodes]), [["followed", "第 2 集"], ["custom", "第 2 集"]]);
  const fresh = { ...series, checkedAt: "2026-10-13", episodes: "第 3 集" };
  assert.equal(followedCatalog([fresh], [series], ["followed"])[0].episodes, "第 3 集");
});

test("link submissions join official calendar entries by canonical URL while retaining their account identifier", () => {
  const event = { at: Date.parse('2026-10-12T10:00:00+08:00'), label: '第3集', published: true, delayed: false };
  const official = { ...series, id: 'bili-123', url: 'https://www.bilibili.com/bangumi/play/ss123', events: [event] };
  const submitted = { ...official, id: 'official-submitted', url: `${official.url}?from=share`, events: [], checkedAt: '2026-10-12T03:00:00Z' };
  const joined = followedCatalog([official], [submitted], [submitted.id]);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].id, submitted.id);
  assert.deepEqual(joined[0].events, [event]);
  assert.equal(weeklySchedule(joined, event.at)[0].entries[0].series.id, submitted.id);
  assert.deepEqual(followedCatalog([official], [submitted], []), []);
});

test("a newer title-only record cannot erase confirmed events or renew an expired recurring schedule", () => {
  const now = Date.parse('2026-10-12T10:00:00+08:00');
  const event = { at: now, label: '第3集', published: true, delayed: false };
  const catalog = { ...series, events: [event], days: [1], time: '10:00', checkedAt: '2026-08-01' };
  const titleOnly = { ...series, title: '已核验新名称', checkedAt: '2026-10-12T03:00:00Z' };
  const joined = followedCatalog([catalog], [titleOnly], [series.id]);
  assert.equal(joined[0].title, '已核验新名称');
  assert.deepEqual(joined[0].events, [event]);
  assert.equal(validSchedule(joined[0], now), false);
  assert.equal(weeklySchedule(joined, now)[0].entries.length, 1);
});

test("canonical-link matching never merges same-name works from different shows or platforms", () => {
  const own = { ...series, id: 'official-own', url: 'https://v.qq.com/x/cover/abc123.html' };
  const other = { ...series, id: 'tencent-other', platform: 'tencent', url: 'https://v.qq.com/x/cover/abc123.html', events: [{ at: 1, label: '第1集', published: true, delayed: false }] };
  assert.deepEqual(followedCatalog([other], [own], [own.id])[0].events, []);
});
