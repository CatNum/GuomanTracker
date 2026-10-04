/** Extracts confirmed releases; schedules, trailers, and planned totals are not releases. */
export function latestPublishedEpisode(series, now = Date.now()) {
  if (Number.isInteger(series.latestEpisode) && series.latestEpisode > 0 && series.latestEpisode <= 10000) return series.latestEpisode;
  const text = typeof series.episodes === 'string' ? series.episodes : '';
  const planned = /预计|预告|计划|预约|明日|下周/.test(text);
  // 只接受独立的已更新标识；任意计划性前缀不能通过子串匹配冒充发布。
  const updated = planned ? null : text.split(/[，,。；;]/).map(part=>part.trim().match(/^(?:已)?更新至\s*(?:第)?\s*(\d+)\s*[集话]$/)).find(Boolean);
  const finished = series.status !== 'finished' || planned ? null : text.match(/^(?:全\s*(\d+)\s*[集话]|(\d+)\s*[集话]\s*全)$/);
  const counts = [updated?.[1], finished?.[1] || finished?.[2]].filter(Boolean).map(Number);
  for (const event of series.events || []) {
    if (!event.published || event.delayed || !Number.isFinite(event.at) || event.at > now || /预告|花絮|特辑/.test(event.label)) continue;
    const episode = String(event.label || '').match(/(?:第\s*)?(\d+)\s*[话集]/);
    if (episode) counts.push(Number(episode[1]));
  }
  const valid = counts.filter((value) => Number.isInteger(value) && value > 0 && value <= 10000);
  return valid.length ? Math.max(...valid) : null;
}
