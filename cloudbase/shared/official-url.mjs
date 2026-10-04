function invalid() {
  const error = new Error('请使用哔哩哔哩、腾讯视频、优酷、爱奇艺或芒果 TV 的官方节目详情/播放 HTTPS 链接。');
  error.code = 'INVALID_URL';
  return error;
}

/** Canonicalizes an official show URL; rejects arbitrary requests before any network operation. */
export function parseOfficialUrl(input) {
  if (typeof input !== 'string' || input.length > 2048 || /[\x00-\x20\\]/u.test(input.trim())) throw invalid();
  let parsed;
  try { parsed = new URL(input.trim()); } catch { throw invalid(); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || /%/u.test(parsed.pathname)) throw invalid();
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  let url;
  let platform;
  if (['www.bilibili.com', 'bilibili.com'].includes(host) && /^\/bangumi\/play\/(?:ss|ep)[1-9]\d*\/?$/u.test(path)) {
    platform = 'bilibili'; url = `https://www.bilibili.com${path.replace(/\/$/u, '')}`;
  } else if (['v.qq.com', 'm.v.qq.com'].includes(host)) {
    const cover = path.match(/^\/x\/cover\/([a-zA-Z0-9]{3,64})(?:\/[a-zA-Z0-9]{3,64})?\.html$/u);
    const video = path.match(/^\/x\/page\/([a-zA-Z0-9]{3,64})\.html$/u);
    if (!cover && !video) throw invalid();
    platform = 'tencent'; url = cover ? `https://v.qq.com/x/cover/${cover[1]}.html` : `https://v.qq.com/x/page/${video[1]}.html`;
  } else if (host === 'v.youku.com') {
    const showId = parsed.searchParams.get('s');
    if (/^\/video\/?$/u.test(path) && showId && /^[a-zA-Z0-9]{8,64}$/u.test(showId) && parsed.searchParams.getAll('s').length === 1) {
      platform = 'youku'; url = `https://v.youku.com/video?s=${showId}`;
    } else if (/^\/v_show\/id_[a-zA-Z0-9=+-]{6,128}\.html$/u.test(path)) {
      platform = 'youku'; url = `https://v.youku.com${path}`;
    } else throw invalid();
  } else if (['www.iqiyi.com', 'iqiyi.com', 'm.iqiyi.com'].includes(host) && /^\/(?:a|v)_[a-zA-Z0-9]{3,64}\.html$/u.test(path)) {
    platform = 'iqiyi'; url = `https://www.iqiyi.com${path}`;
  } else if (['www.mgtv.com', 'mgtv.com', 'm.mgtv.com'].includes(host) && /^\/(?:b\/\d{1,20}(?:\/\d{1,20})?|h\/\d{1,20})\.html$/u.test(path)) {
    platform = 'mgtv'; url = `https://www.mgtv.com${path}`;
  } else throw invalid();
  return { url, platform };
}
