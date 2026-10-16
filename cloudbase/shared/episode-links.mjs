import { parseOfficialUrl } from './official-url.mjs';
import { fetchMetadata } from './scanner.mjs';
import { tencentPageRequest } from './tencent-page.mjs';

const EXTRAS = /预告|花絮|特辑|PV|CM|先导|敬请|即将|预约/iu;
const videoId = (value) => typeof value === 'string' && /^[a-zA-Z0-9=+-]{6,128}$/u.test(value);
function fault(code, message) { return Object.assign(new Error(message), { code }); }
function unavailable() { throw fault('EPISODE_UNAVAILABLE', '暂未找到这一集的官方正片链接，可能尚未上线或官网选集暂不可读取。请重试，或前往官方作品页选集。'); }
function json(text) { try { return JSON.parse(text); } catch { return unavailable(); } }
function uniqueLink(links) {
  const unique = [...new Set(links)];
  if (unique.length > 1) unavailable();
  return unique[0];
}

// Read JSON only; official page scripts are never evaluated.
function initialData(html) {
  const match = /window\.__INITIAL_DATA__\s*=\s*(?=\{)/u.exec(html);
  if (!match) unavailable();
  const start = match.index + match[0].length;
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < html.length; index++) {
    const char = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if ((char === '}' || char === ']') && --depth === 0) return json(html.slice(start, index + 1));
  }
  unavailable();
}

function bilibiliLink(payload, episode, now) {
  if (payload?.code !== 0 || !Array.isArray(payload.result?.episodes)) unavailable();
  return uniqueLink(payload.result.episodes.flatMap(item => {
    if (!item || !/^\d{1,5}$/u.test(String(item.title)) || Number(item.title) !== episode ||
        item.pv || item.is_view_hide || (item.section_type && item.section_type !== 0) || EXTRAS.test(`${item.badge || ''} ${item.long_title || ''}`)) return [];
    const time = item.pub_time ?? item.pub_real_time;
    const published = typeof time === 'number' ? time * (time > 1e12 ? 1 : 1000)
      : Date.parse(typeof time === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(time) ? `${time.replace(' ', 'T')}+08:00` : time);
    const id = item.id ?? item.ep_id;
    return Number.isFinite(published) && published <= +now && Number.isSafeInteger(id) && id > 0
      ? [`https://www.bilibili.com/bangumi/play/ep${id}`] : [];
  }));
}

function tencentModules(payload) {
  if (payload?.ret !== 0 || !Array.isArray(payload.data?.CardList)) unavailable();
  return payload.data.CardList.filter(card => card?.type === 'pc_web_episode_list');
}
function tencentItems(modules) {
  return modules.flatMap(card => Object.values(card.children_list || {}).flatMap(group => Array.isArray(group?.cards) ? group.cards : []));
}
function tencentLink(modules, cid, episode) {
  return uniqueLink(tencentItems(modules).flatMap(({ params: item }) => {
    return item?.cid === cid && /^\d{1,5}$/u.test(item.title) && Number(item.title) === episode &&
      item.is_trailer === '0' && !EXTRAS.test(item.play_title || '') && /^[a-zA-Z0-9]{3,64}$/u.test(item.vid)
      ? [`https://v.qq.com/x/cover/${cid}/${item.vid}.html`] : [];
  }));
}
async function tencentPage(params, options, context = {}) {
  const request = tencentPageRequest(params, context);
  const { text } = await fetchMetadata(request.url, { ...options, ...request });
  return tencentModules(json(text));
}

function youkuSelection(html, expectedShow) {
  const data = initialData(html);
  const show = data?.pageMap?.extra?.showId;
  if (typeof show !== 'string' || !/^[a-zA-Z0-9]{8,64}$/u.test(show) || (expectedShow && show !== expectedShow)) unavailable();
  const components = (Array.isArray(data.moduleList) ? data.moduleList : []).flatMap(module => Array.isArray(module?.components) ? module.components : []).filter(component => component?.type === 10013);
  return { show, components };
}
function youkuLink(selection, episode) {
  return uniqueLink(selection.components.flatMap(component => (Array.isArray(component.itemList) ? component.itemList : []).flatMap(item => {
    const action = item?.action;
    return item?.stage === episode && item.videoType === '正片' && item.episodeInfo?.isZp === true &&
      !EXTRAS.test(`${item.title || ''} ${item.mark?.text || ''}`) && action?.type === 'JUMP_TO_VIDEO' &&
      action.extra?.showId === selection.show && videoId(action.value)
      ? [`https://v.youku.com/v_show/id_${action.value}.html`] : [];
  })));
}

/** resolveOfficialEpisode（解析官方单集）：按正片集号读取真实单集编号，无法确认时拒绝猜测。 */
export async function resolveOfficialEpisode(input, episode, { now = new Date(), fetcher = fetch, timeoutMs = 5000, maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(episode) || episode < 1 || episode > 10000) throw fault('INVALID_EPISODE', '请输入 1 至 10000 之间的整数集号。');
  const official = parseOfficialUrl(input);
  const options = { fetcher, timeoutMs, maxBytes };
  let url;
  if (official.platform === 'bilibili') {
    const id = new URL(official.url).pathname.match(/\/(ss|ep)(\d+)$/u);
    const { text } = await fetchMetadata(`https://api.bilibili.com/pgc/view/web/season?${id[1] === 'ss' ? 'season_id' : 'ep_id'}=${id[2]}`, { ...options, platform: 'bilibili' });
    url = bilibiliLink(json(text), episode, now);
  } else if (official.platform === 'tencent') {
    const path = new URL(official.url).pathname;
    let cid = path.match(/\/cover\/([a-zA-Z0-9]+)\.html$/u)?.[1];
    const vid = path.match(/\/page\/([a-zA-Z0-9]+)\.html$/u)?.[1] || '';
    let modules = await tencentPage({ page_type: 'detail', page_id: 'detail', cid: cid || '', vid }, options);
    cid ||= tencentItems(modules).find(item => item.params?.vid === vid)?.params?.cid;
    if (!cid || !/^[a-zA-Z0-9]{3,64}$/u.test(cid)) unavailable();
    url = tencentLink(modules, cid, episode);
    if (!url) {
      const tabs = modules.flatMap(module => {
        try { const value = JSON.parse(module.params?.tabs || '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
      });
      const tab = tabs.find(tab => episode >= tab?.begin && episode <= tab?.end && typeof tab.page_context === 'string' && tab.page_context.length <= 10000);
      if (tab) {
        modules = await tencentPage({ page_type: 'detail_operation', page_id: 'vsite_episode_list', cid, vid: '', page_context: tab.page_context }, options, { latestPageContext: tab.page_context });
        url = tencentLink(modules, cid, episode);
      }
    }
  } else if (official.platform === 'youku') {
    const { text } = await fetchMetadata(official.url, { ...options, platform: 'youku' });
    const selection = youkuSelection(text, new URL(official.url).searchParams.get('s'));
    url = youkuLink(selection, episode);
    if (!url) {
      const latest = selection.components.flatMap(component => Array.isArray(component.series) ? component.series : []).find(series => series?.current === true && series.showId === selection.show && videoId(series.lastEpisodeVideoId));
      if (latest) {
        const lastUrl = `https://v.youku.com/v_show/id_${latest.lastEpisodeVideoId}.html`;
        if (lastUrl !== official.url) {
          const last = await fetchMetadata(lastUrl, { ...options, platform: 'youku' });
          url = youkuLink(youkuSelection(last.text, selection.show), episode);
        }
      }
    }
  } else throw fault('UNSUPPORTED_PLATFORM', '目前仅支持哔哩哔哩、腾讯视频和优酷。');
  if (!url) unavailable();
  return { episode, url };
}
