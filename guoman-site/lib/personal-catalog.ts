import type { Anime } from "./catalog.ts";
import { parseOfficialUrl } from '../../cloudbase/shared/official-url.mjs';

function officialKey(series: Anime): string | null {
  try {
    const official = parseOfficialUrl(series.url);
    return official.platform === series.platform ? `${official.platform}:${official.url}` : null;
  } catch { return null; }
}

function mergeCalendarSeries(personal: Anime, catalog: Anime): Anime {
  const catalogIsNewer = (Date.parse(catalog.checkedAt) || 0) >= (Date.parse(personal.checkedAt) || 0);
  const metadata = catalogIsNewer ? catalog : personal;
  // A title-only submission has no schedule evidence, regardless of its newer timestamp.
  const schedule = !catalogIsNewer && (personal.events.length || (personal.days?.length && personal.time)) ? personal : catalog;
  return { ...metadata, id: personal.id, events: schedule.events, days: schedule.days, time: schedule.time,
    schedule: schedule.schedule, scheduleCheckedAt: schedule.scheduleCheckedAt ?? schedule.checkedAt };
}

/** followedCatalog（已追番目录）：保留账号补录及较新资料，只返回当前账号已追番作品。 */
export function followedCatalog(items: Anime[], personalSeries: Anime[], followed: string[]): Anime[] {
  const wanted = new Set(followed);
  const byId = new Map(personalSeries.filter(series => wanted.has(series.id)).map(series => [series.id, series]));
  const byLink = new Map<string, Anime>();
  for (const series of byId.values()) {
    const key = officialKey(series);
    if (key) byLink.set(key, series);
  }
  for (const series of items) {
    const key = officialKey(series);
    const known = byId.get(series.id) ?? (key ? byLink.get(key) : undefined);
    if (known) byId.set(known.id, mergeCalendarSeries(known, series));
    else if (wanted.has(series.id)) byId.set(series.id, series);
  }
  return [...byId.values()];
}
