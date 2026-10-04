/** 集数表示正在看或最近看完的那一集，0 表示尚未开始。旧秒数只用于一次性兼容转换。 */
export function normalizeEpisodeProgress(state) {
  const { watchedEpisode, positionSeconds, ...rest } = state;
  if (Number.isInteger(rest.currentEpisode) && typeof rest.episodeCompleted === 'boolean') return rest;
  const completed = Number.isInteger(watchedEpisode) && watchedEpisode > 0 ? watchedEpisode : 0;
  const partial = Number.isFinite(positionSeconds) && positionSeconds > 0;
  return { ...rest, currentEpisode: completed + Number(partial), episodeCompleted: !partial && completed > 0 };
}

/** 已完整看完的集数；当前集未看完时，完成数停留在前一集。 */
export function completedEpisodeCount(state) {
  return Math.max(0, state.currentEpisode - Number(!state.episodeCompleted));
}

/** 两种存储入口共用的进度边界，未开始不能标记为看完。 */
export function validEpisodeProgress(episode, completed, latest) {
  return Number.isInteger(episode) && episode >= 0 && episode <= 10000 &&
    (latest === null || episode <= latest) && typeof completed === 'boolean' &&
    (episode > 0 || completed === false);
}
