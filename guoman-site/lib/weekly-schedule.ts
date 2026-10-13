import { chinaDate, chinaDay, dayNames, isSupportedPlatform, validSchedule, type Anime } from "./catalog.ts";

export type WeeklyEntry = {
  series: Anime;
  at: number;
  label: string;
  delayed: boolean;
  published: boolean;
};

/** unverifiedSchedule（排期待核验作品）：单独列出已追番而无法确定更新日期的作品。 */
export function unverifiedSchedule(items: Anime[], now: number): Anime[] {
  const monday = Date.parse(`${chinaDate(now)}T00:00:00+08:00`) - ((chinaDay(now) + 6) % 7) * 86400000;
  return items.filter(series => isSupportedPlatform(series.platform) && series.status !== 'finished'
    && !validSchedule(series, now) && !series.events.some(event => event.at >= monday));
}

/** weeklySchedule（本周排期）：将官方事件和有效固定排期归入北京时间的七天，不推断实际已上线。 */
export function weeklySchedule(items: Anime[], now: number) {
  const monday = Date.parse(`${chinaDate(now)}T00:00:00+08:00`) - ((chinaDay(now) + 6) % 7) * 86400000;
  return Array.from({ length: 7 }, (_, index) => {
    const start = monday + index * 86400000;
    const date = chinaDate(start);
    const day = chinaDay(start);
    const entries: WeeklyEntry[] = [];
    for (const series of items) {
      if (!isSupportedPlatform(series.platform)) continue;
      const events = series.events.filter(event => event.at >= start && event.at < start + 86400000);
      if (events.length) {
        entries.push(...events.map(event => ({ ...event, series })));
      } else if (series.status !== "finished" && validSchedule(series, now) && series.days?.includes(day)) {
        const at = Date.parse(`${date}T${series.time}:00+08:00`);
        if (Number.isFinite(at)) entries.push({ series, at, label: "计划更新", delayed: false, published: false });
      }
    }
    entries.sort((a, b) => a.at - b.at || a.series.title.localeCompare(b.series.title, "zh-CN"));
    return { date, day, label: dayNames[day], today: date === chinaDate(now), entries };
  });
}
