import assert from "node:assert/strict";
import test from "node:test";
import type { Anime } from "../lib/catalog.ts";
import { weeklySchedule, unverifiedSchedule } from "../lib/weekly-schedule.ts";

const now = Date.parse("2026-10-12T10:00:00+08:00");
const series: Anime = {
  id: "a", title: "测试国漫", platform: "bilibili", url: "https://www.bilibili.com/",
  cover: "", status: "ongoing", episodes: "第 2 集", checkedAt: "2026-10-12",
  source: "official", events: [], days: [1, 0], time: "11:00",
};

test("week uses Beijing Monday through Sunday even at the UTC Sunday boundary", () => {
  const week = weeklySchedule([series], Date.parse("2026-10-11T16:30:00Z"));
  assert.deepEqual(week.map(day => day.date), ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
  assert.equal(week[0].entries[0].at, Date.parse("2026-10-12T11:00:00+08:00"));
  assert.equal(week[6].entries[0].at, Date.parse("2026-10-18T11:00:00+08:00"));
  assert.equal(weeklySchedule([], Date.parse("2026-10-18T23:59:00+08:00"))[0].date, "2026-10-12");
});

test("dated official events override recurring slots and retain delay and publication status", () => {
  const week = weeklySchedule([{ ...series, events: [
    { at: Date.parse("2026-10-12T12:00:00+08:00"), label: "第 3 集延期", delayed: true, published: false },
    { at: Date.parse("2026-10-18T09:00:00+08:00"), label: "第 4 集", delayed: false, published: true },
    { at: Date.parse("2026-10-19T09:00:00+08:00"), label: "下周更新", delayed: false, published: false },
  ] }], now);
  assert.deepEqual(week[0].entries.map(entry => [entry.at, entry.label, entry.delayed, entry.published]), [[Date.parse("2026-10-12T12:00:00+08:00"), "第 3 集延期", true, false]]);
  assert.equal(week[6].entries.length, 1);
  assert.equal(week[6].entries[0].published, true);
});

test("stale, finished and unsupported recurring schedules never invent updates", () => {
  const week = weeklySchedule([
    { ...series, id: "old", checkedAt: "2026-08-01" },
    { ...series, id: "ended", status: "finished" },
    { ...series, id: "unsupported", platform: "iqiyi" },
    { ...series, id: "unknown", days: undefined },
  ], now);
  assert.equal(week.flatMap(day => day.entries).length, 0);
});

test("real dated events remain visible without recurring data, sorted by time", () => {
  const event = { at: Date.parse("2026-10-12T09:00:00+08:00"), label: "完结篇", delayed: false, published: true };
  const week = weeklySchedule([series, { ...series, id: "finale", status: "finished", checkedAt: "2026-08-01", events: [event] }], now);
  assert.deepEqual(week[0].entries.map(entry => entry.series.id), ["finale", "a"]);
  assert.equal(week[0].entries[1].published, false);
});

test("new follows with no verified schedule remain visible separately without an invented weekday", () => {
  const pending = { ...series, id: 'new-follow', events: [], days: undefined, time: undefined };
  const items = [pending, series, { ...pending, id: 'finished', status: 'finished' }, { ...pending, id: 'unsupported', platform: 'iqiyi' }];
  assert.deepEqual(unverifiedSchedule(items, now).map(item => item.id), ['new-follow']);
  assert.equal(weeklySchedule([pending], now).flatMap(day => day.entries).length, 0);
  assert.deepEqual(unverifiedSchedule([], now), []);
});

test("expired schedules need verification but a confirmed future event does not", () => {
  const old = { ...series, id: 'old', checkedAt: '2026-08-01' };
  const future = { ...old, id: 'future', events: [{ at: Date.parse('2026-10-19T10:00:00+08:00'), label: '第5集', delayed: false, published: false }] };
  assert.deepEqual(unverifiedSchedule([old, future], now).map(item => item.id), ['old']);
});
