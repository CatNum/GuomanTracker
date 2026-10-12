/** 平台编号：前后端共同使用的唯一可操作平台名单。 */
export const SUPPORTED_PLATFORMS = Object.freeze(['bilibili', 'tencent', 'youku']);

/** 判断平台编号是否允许用于追番、进度和扫描操作。 */
export function isSupportedPlatform(platform) {
  return SUPPORTED_PLATFORMS.includes(platform);
}

/** 为无法读取官方标题的新补录生成可辨认且稳定的暂存名称。 */
export function pendingSeriesTitle(official) {
  const url = new URL(official.url);
  let identifier = '';
  if (official.platform === 'bilibili') {
    const match = url.pathname.match(/\/(ss|ep)([1-9]\d*)$/u);
    if (match) identifier = `${match[1]}${match[2]}`;
  } else if (official.platform === 'tencent') {
    identifier = url.pathname.split('/').filter(Boolean).at(-1)?.replace(/\.html$/u, '') || '';
  } else if (official.platform === 'youku') {
    identifier = url.searchParams.get('s') || url.pathname.match(/\/id_([^/]+)\.html$/u)?.[1] || '';
  }
  const name = { bilibili: 'B站', tencent: '腾讯视频', youku: '优酷' }[official.platform] || '待核验平台';
  return `${name}待核验节目${identifier ? ` ${identifier}` : ''}`;
}
