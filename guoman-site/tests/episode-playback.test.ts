import test from 'node:test';
import assert from 'node:assert/strict';
import { openEpisodePlayback } from '../lib/episode-playback.ts';

const result = { episode: 91, url: 'https://v.qq.com/x/cover/mzc00200aaogpgh/b4101sajivb.html' };
function popup() {
  const navigations: string[] = [];
  return { opener: {} as unknown, closed: false, navigations, location: { replace: (url: string) => { navigations.push(url); } }, close() { this.closed = true; } };
}

test('opens a reserved tab before async lookup and navigates only after a validated result', async () => {
  const tab = popup();
  let reserved = false;
  let opened = 0;
  const link = await openEpisodePlayback({
    platform: 'tencent', episode: 91,
    openWindow: () => { reserved = true; return tab; },
    resolve: async () => { assert.equal(reserved, true); assert.equal(tab.opener, null); return result; },
    isActive: () => true, onOpened: () => { opened++; },
  });
  assert.equal(link, result.url);
  assert.deepEqual(tab.navigations, [result.url]);
  assert.equal(opened, 1);
});

test('an upstream failure closes the blank tab without recording an open', async () => {
  const tab = popup();
  let opened = false;
  await assert.rejects(openEpisodePlayback({ platform: 'tencent', episode: 91, openWindow: () => tab,
    resolve: async () => { throw new Error('official unavailable'); }, isActive: () => true, onOpened: () => { opened = true; } }), /official unavailable/);
  assert.equal(tab.closed, true);
  assert.deepEqual(tab.navigations, []);
  assert.equal(opened, false);
});

test('a blocked popup leaves a validated manual link without recording an open', async () => {
  let opened = false;
  assert.equal(await openEpisodePlayback({ platform: 'tencent', episode: 91, openWindow: () => null,
    resolve: async () => result, isActive: () => true, onOpened: () => { opened = true; } }), result.url);
  assert.equal(opened, false);
});

test('a canceled request cannot navigate after its dialog or account closes', async () => {
  const tab = popup();
  let active = true;
  let opened = false;
  assert.equal(await openEpisodePlayback({ platform: 'tencent', episode: 91, openWindow: () => tab,
    resolve: async () => { active = false; return result; }, isActive: () => active, onOpened: () => { opened = true; } }), null);
  assert.equal(tab.closed, true);
  assert.deepEqual(tab.navigations, []);
  assert.equal(opened, false);
});

test('a tab closed by the user is never reopened or recorded', async () => {
  const tab = popup();
  let opened = false;
  assert.equal(await openEpisodePlayback({ platform: 'tencent', episode: 91, openWindow: () => tab,
    resolve: async () => { tab.close(); return result; }, isActive: () => true, onOpened: () => { opened = true; } }), result.url);
  assert.equal(opened, false);
  assert.deepEqual(tab.navigations, []);
});

test('malformed or mismatched results cannot navigate the reserved tab', async () => {
  for (const value of [null, { ...result, episode: 90 }, { ...result, url: 'javascript:alert(1)' }, { ...result, url: 'https://evil.example/watch' }, { ...result, url: 'https://v.qq.com/x/cover/mzc00200aaogpgh.html' }, { ...result, url: 'https://www.bilibili.com/bangumi/play/ep733316' }, { ...result, url: 'https://v.qq.com:444/x/page/b4101sajivb.html' }]) {
    const tab = popup();
    await assert.rejects(openEpisodePlayback({ platform: 'tencent', episode: 91, openWindow: () => tab,
      resolve: async () => value, isActive: () => true, onOpened: () => assert.fail('must not record') }));
    assert.equal(tab.closed, true);
    assert.deepEqual(tab.navigations, []);
  }
});

test('non-positive, fractional or excessive episodes never open a tab or request metadata', async () => {
  for (const episode of [0, -1, 1.5, NaN, 10001]) {
    await assert.rejects(openEpisodePlayback({ platform: 'tencent', episode,
      openWindow: () => assert.fail('must not open'), resolve: async () => assert.fail('must not fetch'),
      isActive: () => true, onOpened: () => assert.fail('must not record') }));
  }
});
