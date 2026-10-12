/** 当候选变化时按作品 ID 保留当前选择；作品已移除时回退到默认作品。 */
export function validDeckSelection(ids: string[], selectedId: string | null, defaultId: string): string {
  return selectedId && ids.includes(selectedId) ? selectedId : defaultId;
}

/** 只返回当前选中作品附近的有限可视窗口，避免大量卡片同时叠放。 */
export function visibleDeckIds(ids: string[], selectedId: string, limit = 5): string[] {
  if (ids.length <= limit) return ids;
  const index = Math.max(0, ids.indexOf(selectedId));
  const start = Math.max(0, Math.min(index - Math.floor(limit / 2), ids.length - limit));
  return ids.slice(start, start + limit);
}
