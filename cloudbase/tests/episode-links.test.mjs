import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOfficialEpisode } from '../shared/episode-links.mjs';

const bili = 'https://www.bilibili.com/bangumi/play/ss28747';
const tencent = 'https://v.qq.com/x/cover/mzc00200aaogpgh.html';
const youku = 'https://v.youku.com/video?s=adaec02f09f9469ab8d8';
const response = (value) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const biliEpisode = (extra = {}) => ({ id: 733316, title: '1', long_title: '凡人风起天南1重制版', pub_time: 1675566000, pv: 0, section_type: 0, is_view_hide: false, ...extra });
const tencentCard = (items, tabs = []) => ({ type: 'pc_web_episode_list', params: { tabs: JSON.stringify(tabs) }, children_list: { 0: { cards: items.map(params => ({ params })) } } });
const tencentEpisode = (extra = {}) => ({ cid: 'mzc00200aaogpgh', vid: 'r0047gdjpw6', title: '1', play_title: '仙逆 第01话', is_trailer: '0', ...extra });
const youkuItem = (extra = {}) => ({ stage: 1, videoType: '正片', episodeInfo: { isZp: true }, title: '所有妖怪都得死', action: { type: 'JUMP_TO_VIDEO', value: 'XNTk3MzA5NzgzMg==', extra: { showId: 'adaec02f09f9469ab8d8' } }, ...extra });
const youkuHtml = (items, extra = {}) => `<script>window.__INITIAL_DATA__ =${JSON.stringify({ pageMap: { extra: { showId: 'adaec02f09f9469ab8d8' } }, moduleList: [{ components: [{ type: 10013, itemList: items, ...extra }] }] })};</script>`;

test('Bilibili resolves the actual numbered episode, independent of array order', async () => {
  const result = await resolveOfficialEpisode(bili, 1, { fetcher: async url => {
    assert.equal(url, 'https://api.bilibili.com/pgc/view/web/season?season_id=28747');
    return response({ code: 0, result: { episodes: [biliEpisode({ id: 999999, title: '2' }), biliEpisode()] } });
  } });
  assert.deepEqual(result, { episode: 1, url: 'https://www.bilibili.com/bangumi/play/ep733316' });
});

test('Bilibili accepts an episode URL as the source', async () => {
  await resolveOfficialEpisode('https://www.bilibili.com/bangumi/play/ep733316', 1, { fetcher: async url => {
    assert.equal(url, 'https://api.bilibili.com/pgc/view/web/season?ep_id=733316');
    return response({ code: 0, result: { episodes: [biliEpisode()] } });
  } });
});

test('Bilibili excludes previews, hidden episodes, future releases and ambiguous numbering', async () => {
  for (const episodes of [[biliEpisode({ pv: 1 })], [biliEpisode({ is_view_hide: true })], [biliEpisode({ pub_time: 4102444800 })], [biliEpisode({ long_title: '第1集预告' })], [biliEpisode(), biliEpisode({ id: 888888 })]]) {
    await assert.rejects(resolveOfficialEpisode(bili, 1, { fetcher: async () => response({ code: 0, result: { episodes } }) }), { code: 'EPISODE_UNAVAILABLE' });
  }
});

test('Tencent resolves a single-episode URL from its official episode module only', async () => {
  const result = await resolveOfficialEpisode(tencent, 1, { fetcher: async (url, options) => {
    assert.equal(new URL(url).hostname, 'pbaccess.video.qq.com');
    assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(options.body).page_params.cid, 'mzc00200aaogpgh');
    return response({ ret: 0, data: { CardList: [{ type: 'pc_video_clips', children_list: { 0: { cards: [{ params: tencentEpisode({ vid: 'wrongclip' }) }] } } }, tencentCard([tencentEpisode()])] } });
  } });
  assert.deepEqual(result, { episode: 1, url: 'https://v.qq.com/x/cover/mzc00200aaogpgh/r0047gdjpw6.html' });
});

test('Tencent follows the official interval containing the requested episode', async () => {
  let calls = 0;
  const result = await resolveOfficialEpisode(tencent, 91, { fetcher: async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    if (calls === 1) return response({ ret: 0, data: { CardList: [tencentCard([tencentEpisode()], [{ begin: 91, end: 120, page_context: 'cid=mzc00200aaogpgh&episode_begin=91&episode_end=120' }])] } });
    assert.equal(body.page_params.page_id, 'vsite_episode_list');
    assert.equal(body.page_params.page_context, 'cid=mzc00200aaogpgh&episode_begin=91&episode_end=120');
    return response({ ret: 0, data: { CardList: [tencentCard([tencentEpisode({ title: '91', play_title: '仙逆 第91话', vid: 'b4101sajivb' })])] } });
  } });
  assert.equal(calls, 2);
  assert.equal(result.url, 'https://v.qq.com/x/cover/mzc00200aaogpgh/b4101sajivb.html');
});

test('Tencent excludes trailers and episodes belonging to another show', async () => {
  for (const item of [tencentEpisode({ is_trailer: '1' }), tencentEpisode({ cid: 'another123' }), tencentEpisode({ play_title: '仙逆 第1话预告' })]) {
    await assert.rejects(resolveOfficialEpisode(tencent, 1, { fetcher: async () => response({ ret: 0, data: { CardList: [tencentCard([item])] } }) }), { code: 'EPISODE_UNAVAILABLE' });
  }
});

test('Youku reads numbered main episodes from its initial data without executing scripts', async () => {
  const result = await resolveOfficialEpisode(youku, 1, { fetcher: async () => response(youkuHtml([youkuItem({ stage: '花絮', videoType: '剧集看点' }), youkuItem()])) });
  assert.deepEqual(result, { episode: 1, url: 'https://v.youku.com/v_show/id_XNTk3MzA5NzgzMg==.html' });
});

test('Youku can read the later interval using the official last-episode video ID', async () => {
  let calls = 0;
  const result = await resolveOfficialEpisode(youku, 91, { fetcher: async url => {
    calls++;
    if (calls === 1) return response(youkuHtml([youkuItem()], { series: [{ current: true, showId: 'adaec02f09f9469ab8d8', lastEpisodeVideoId: 'XNjUyOTc2NDQ0NA==' }] }));
    assert.equal(url, 'https://v.youku.com/v_show/id_XNjUyOTc2NDQ0NA==.html');
    return response(youkuHtml([youkuItem({ stage: 91 })]));
  } });
  assert.equal(calls, 2);
  assert.equal(result.episode, 91);
});

test('Youku rejects previews, different shows, absent episodes and executable non-JSON data', async () => {
  for (const html of [youkuHtml([youkuItem({ videoType: '预告', episodeInfo: { isZp: false } })]), youkuHtml([youkuItem({ action: { type: 'JUMP_TO_VIDEO', value: 'XNTk3MzA5NzgzMg==', extra: { showId: 'other123' } } })]), youkuHtml([]), '<script>window.__INITIAL_DATA__ = (() => { throw new Error("never execute"); })();</script>']) {
    await assert.rejects(resolveOfficialEpisode(youku, 1, { fetcher: async () => response(html) }), { code: 'EPISODE_UNAVAILABLE' });
  }
});

test('invalid episodes and arbitrary hosts are rejected before network access', async () => {
  let requests = 0;
  const options = { fetcher: async () => { requests++; throw new Error('must not fetch'); } };
  for (const episode of [0, -1, 1.5, '1', 10001, NaN]) await assert.rejects(resolveOfficialEpisode(bili, episode, options), { code: 'INVALID_EPISODE' });
  await assert.rejects(resolveOfficialEpisode('https://evil.example/ss123', 1, options), { code: 'INVALID_URL' });
  assert.equal(requests, 0);
});

test('official failures and cross-host redirects never produce a guessed link', async () => {
  await assert.rejects(resolveOfficialEpisode(bili, 1, { fetcher: async () => response({ code: -1 }) }), { code: 'EPISODE_UNAVAILABLE' });
  await assert.rejects(resolveOfficialEpisode(youku, 1, { fetcher: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/watch' } }) }), { code: 'INVALID_URL' });
});
