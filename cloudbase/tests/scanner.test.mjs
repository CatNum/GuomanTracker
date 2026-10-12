import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOfficialUrl } from '../shared/official-links.mjs';
import { parseOfficialUrl } from '../shared/official-url.mjs';
import { fetchMetadata, parseBilibili, parseOfficialHtml, selectDueTargets, runScanBatch, authorizeScanner, seedHotTargets } from '../shared/scanner.mjs';

const NOW = new Date('2026-10-05T04:00:00.000Z');

test('official submission URLs reject SSRF, credentials, search, short links and encoded path tricks', () => {
  for (const url of ['https://127.0.0.1/a', 'https://v.qq.com.evil.test/x/cover/a.html', 'https://u:p@v.qq.com/x/cover/abc.html', 'http://www.iqiyi.com/a_ab.html', 'https://www.youku.com/ku/webcomic/', 'https://b23.tv/abc', 'https://www.bilibili.com/bangumi/play/%73%73%31', 'https://v.qq.com:8443/x/cover/abc.html']) {
    assert.throws(() => normalizeOfficialUrl(url), undefined, url);
  }
});

test('canonical links deduplicate tracking and Tencent episode URLs while preserving Youku show identifier', () => {
  const a = normalizeOfficialUrl('https://v.qq.com/x/cover/mzc0020027yzd9e/abc123.html?from=share#play');
  const b = normalizeOfficialUrl('https://v.qq.com/x/cover/mzc0020027yzd9e.html');
  assert.equal(a.id, b.id);
  assert.equal(a.url, b.url);
  assert.equal(a.platform, 'tencent');
  assert.equal(normalizeOfficialUrl('https://v.youku.com/video?s=adaec02f09f9469ab8d8&spm=test').url, 'https://v.youku.com/video?s=adaec02f09f9469ab8d8');
  assert.deepEqual(parseOfficialUrl('https://m.mgtv.com/b/123/456.html?share=1'), { url: 'https://www.mgtv.com/b/123/456.html', platform: 'mgtv' });
});

test('unsupported platforms are excluded from scan queues and direct scans fail closed', async () => {
  assert.deepEqual(selectDueTargets([
    { seriesId: 'iqiyi', platform: 'iqiyi', source: 'user', nextScanAt: '2026-10-05T00:00:00.000Z' },
    { seriesId: 'bili', platform: 'bilibili', source: 'user', nextScanAt: '2026-10-05T00:00:00.000Z' },
  ], NOW).map(target => target.seriesId), ['bili']);
  await assert.rejects(() => import('../shared/scanner.mjs').then(({ scanOfficialSeries }) => scanOfficialSeries({
    platform: 'iqiyi', url: 'https://www.iqiyi.com/a_abc.html',
  })), { code: 'UNSUPPORTED_PLATFORM' });
});

test('Bilibili release detection excludes future episodes and trailers rather than using total planned count', () => {
  const result = parseBilibili({ code: 0, result: { title: '测试国漫', total: 52, episodes: [
    { title: '1', pub_time: '2026-10-01 10:00:00', badge: '会员' },
    { title: '2', pub_time: '2026-10-06 10:00:00' },
    { title: '3', badge: '预告', pub_time: '2026-10-01 10:00:00' },
    { title: 'PV', pub_time: '2026-10-01 10:00:00' },
    { title: '9', pv: 1, pub_time: '2026-10-01 10:00:00' },
    { title: '10', section_type: 1, pub_time: '2026-10-01 10:00:00' },
    { title: '11', is_view_hide: true, pub_time: '2026-10-01 10:00:00' },
  ] } }, NOW);
  assert.equal(result.latestEpisode, 1);
  assert.equal(result.title, '测试国漫');
});

test('HTML only trusts the show description, never recommendation counts, trailers or total planned episodes', () => {
  assert.equal(parseOfficialHtml('<meta property="og:title" content="国漫 - 腾讯视频"><meta name="description" content="国漫更新至第13集，会员观看"><div>推荐更新至第99集</div>').latestEpisode, 13);
  for (const description of ['预计更新至第14集', '第14集预告，更新至第14集', '全52集', '每周六更新1集', '下周更新至第14集', '将于明日更新至第14集']) {
    assert.throws(() => parseOfficialHtml(`<meta property="og:title" content="国漫"><meta name="description" content="${description}">`), { code: 'UNSUPPORTED' });
  }
});

test('a lower scan response cannot roll back confirmed snapshot episode metadata', async () => {
  let known = { id: 's', title: '国漫', episodes: '更新至第194话' };
  const store = { getSeries: async () => known, updateSeries: async (_id, patch) => { known = { ...known, ...patch }; }, updateTarget: async () => {} };
  await runScanBatch({ targets: [{ seriesId: 's', source: 'user' }], store, now: NOW, scanner: async () => ({ latestEpisode: 193 }) });
  assert.equal(known.latestEpisode, 194);
  assert.equal(known.episodes, '更新至第194集');
});

test('network reader checks each redirect before fetching, rejects media and limits response bodies', async () => {
  const calls = [];
  await assert.rejects(fetchMetadata('https://v.qq.com/x/cover/abc.html', { fetcher: async (url) => {
    calls.push(url); return new Response('', { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } });
  } }), { code: 'INVALID_URL' });
  assert.equal(calls.length, 1);
  await assert.rejects(fetchMetadata('https://v.qq.com/x/cover/abc.html', { fetcher: async () => new Response('video', { headers: { 'content-type': 'video/mp4' } }) }), { code: 'INVALID_CONTENT' });
  await assert.rejects(fetchMetadata('https://v.qq.com/x/cover/abc.html', { maxBytes: 10, fetcher: async () => new Response('12345678901', { headers: { 'content-type': 'text/html' } }) }), { code: 'BODY_TOO_LARGE' });
});

test('due scanning is capped at twenty, prioritizes user submissions and excludes unregistered or future targets', () => {
  const targets = Array.from({ length: 40 }, (_, i) => ({ seriesId: String(i), source: 'hot', nextScanAt: '2026-10-05T00:00:00.000Z' }));
  targets.push({ seriesId: 'submitted', source: 'user', nextScanAt: '2026-10-05T03:00:00.000Z' });
  targets.push({ seriesId: 'future', source: 'user', nextScanAt: '2026-10-06T00:00:00.000Z' });
  targets.push({ seriesId: 'unknown', source: 'other', nextScanAt: '2026-10-05T00:00:00.000Z' });
  const due = selectDueTargets(targets, NOW, 200);
  assert.equal(due.length, 20);
  assert.equal(due[0].seriesId, 'submitted');
  assert.equal(due.some(t => ['future', 'unknown'].includes(t.seriesId)), false);
});

test('scan failures preserve confirmed progress and back off; success reschedules user targets for six hours', async () => {
  const series = { s: { id: 's', latestEpisode: 12, title: '国漫', episodes: '更新至12集' } };
  const savedTargets = [];
  const store = {
    getSeries: async id => series[id],
    updateSeries: async (id, patch) => { series[id] = { ...series[id], ...patch }; },
    updateTarget: async (id, patch) => savedTargets.push({ id, ...patch }),
  };
  const targets = [{ seriesId: 's', url: 'https://v.qq.com/x/cover/abc.html', source: 'user', failureCount: 10 }];
  await runScanBatch({ targets, store, now: NOW, scanner: async () => { throw new Error('network'); } });
  assert.equal(series.s.latestEpisode, 12);
  assert.equal(series.s.monitoring, 'error');
  assert.equal(savedTargets[0].nextScanAt, '2026-10-12T04:00:00.000Z');
  await runScanBatch({ targets, store, now: NOW, scanner: async () => ({ title: '国漫', latestEpisode: 13, episodes: '更新至13集' }) });
  assert.equal(series.s.latestEpisode, 13);
  assert.equal(series.s.monitoring, 'active');
  assert.equal(savedTargets[1].nextScanAt, '2026-10-05T10:00:00.000Z');
  assert.equal(savedTargets[1].failureCount, 0);
});

test('scanner authentication fails closed without random server secret and rejects forged timer events from users', () => {
  assert.equal(authorizeScanner({ Type: 'Timer' }, {}, ''), false);
  assert.equal(authorizeScanner({ Type: 'Timer', Message: 'placeholder' }, {}, 'placeholder'), false);
  const secret = '0'.repeat(64);
  assert.equal(authorizeScanner({ Type: 'Timer', Message: JSON.stringify({ scanKey: secret }) }, { uid: 'user' }, secret), false);
  assert.equal(authorizeScanner({ Type: 'Timer', Message: JSON.stringify({ scanKey: secret }) }, {}, secret), true);
  assert.equal(authorizeScanner({ Type: 'Timer', Message: JSON.stringify({ scanKey: '1'.repeat(64) }) }, {}, secret), false);
});
test('failed attempts never refresh the timestamp of confirmed episode metadata', async () => {
  const checkedAt='2026-10-01T00:00:00.000Z';
  let series={id:'s',latestEpisode:12,lastScanAt:checkedAt,checkedAt,events:[]};
  await runScanBatch({targets:[{seriesId:'s',source:'user',nextScanAt:'2026-10-01T00:00:00.000Z'}],now:NOW,scanner:async()=>{throw new Error('offline');},store:{getSeries:async()=>series,updateSeries:async(_id,patch)=>{series={...series,...patch};},updateTarget:async()=>{}}});
  assert.equal(series.lastScanAt,checkedAt);
  assert.equal(series.checkedAt,checkedAt);
  assert.equal(series.lastScanAttemptAt,NOW.toISOString());
});

test('hot seed import never exceeds thirty and does not overwrite a user target', () => {
  const list = Array.from({ length: 31 }, (_, i) => ({ id: String(i), url: `https://www.bilibili.com/bangumi/play/ss${i + 1}` }));
  assert.throws(() => seedHotTargets(list, [], NOW), { code: 'SEED_LIMIT' });
  const targets = seedHotTargets(list.slice(0, 2), [{ seriesId: '0', source: 'user' }], NOW);
  assert.deepEqual(targets.map(t => t.seriesId), ['1']);
  assert.equal(targets[0].source, 'hot');
});
