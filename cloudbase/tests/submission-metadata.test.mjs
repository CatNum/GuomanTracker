import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOfficialMetadata } from '../shared/submission-metadata.mjs';

function response(body, contentType = 'text/html; charset=utf-8', status = 200, headers = {}) {
  return new Response(body, { status, headers: { 'content-type': contentType, ...headers } });
}

const tencentCard = (type, cards) => ({ type, children_list: { 0: { cards: cards.map(params => ({ params })) } } });
const tencentShow = (overrides = {}) => ({ ret: 0, data: { CardList: [tencentCard('pc_introduction', [{ title: '完美世界', 'report.cid': 'mcv8hkc8zk8lnov', new_pic_vt: 'https://img.example.test/cover.jpg', ...overrides }])] } });
const tencentResponse = (payload) => response(JSON.stringify(payload), 'application/json');
const tencentUrl = 'https://v.qq.com/x/cover/mcv8hkc8zk8lnov.html';
const youkuUrl = 'https://v.youku.com/v_show/id_XMzEyMzQ1.html';

test('Bilibili title is available even when there are no published episodes', async () => {
  let requested;
  const result = await resolveOfficialMetadata({ url: 'https://www.bilibili.com/bangumi/play/ss12345', platform: 'bilibili' }, {
    fetcher: async (url) => {
      requested = url;
      return response(JSON.stringify({ code: 0, result: { title: '独立番名', cover: 'https://i.example.test/cover.jpg', episodes: [] } }), 'application/json');
    },
  });

  assert.equal(requested, 'https://api.bilibili.com/pgc/view/web/season?season_id=12345');
  assert.deepEqual(result, { title: '独立番名', cover: 'https://i.example.test/cover.jpg' });
});

test('Tencent uses the fixed public page API and accepts only the matching introduction card', async () => {
  let requested;
  const result = await resolveOfficialMetadata({ url: 'https://v.qq.com/x/cover/mcv8hkc8zk8lnov.html', platform: 'tencent' }, {
    fetcher: async (url, options) => {
      requested = { url, options };
      return response(JSON.stringify(tencentShow()), 'application/json');
    },
  });

  assert.equal(requested.url, 'https://pbaccess.video.qq.com/trpc.vector_layout.page_view.PageService/getPage?video_appid=3000010&vversion_platform=2&vversion_name=8.5.96');
  assert.equal(requested.options.method, 'POST');
  assert.equal(requested.options.redirect, 'manual');
  assert.equal(requested.options.headers['content-type'], 'application/json');
  assert.equal(requested.options.headers.authorization, undefined);
  assert.equal(requested.options.headers.cookie, undefined);
  assert.equal(requested.options.credentials, undefined);
  assert.deepEqual(JSON.parse(requested.options.body), {
    page_params: { req_from: 'web_vsite', new_mark_label_enabled: '1', page_type: 'detail', page_id: 'detail', cid: 'mcv8hkc8zk8lnov', vid: '' },
    page_bypass_params: { params: { caller_id: '3000010', platform_id: '2' }, scene: 'desk_detail', app_version: '' },
    page_context: {},
  });
  assert.deepEqual(result, { title: '完美世界', cover: 'https://img.example.test/cover.jpg' });
});

test('Tencent rejects failed, unrelated, ambiguous, and title-less official cards', async (t) => {
  const cases = [
    ['nonzero API result', { ret: 1, data: { CardList: [tencentCard('pc_introduction', [{ title: '完美世界', 'report.cid': 'mcv8hkc8zk8lnov' }])] } }],
    ['mismatched programme identity', tencentShow({ 'report.cid': 'another-show' })],
    ['recommendation card only', { ret: 0, data: { CardList: [tencentCard('pc_recommend', [{ title: '推荐标题', 'report.cid': 'mcv8hkc8zk8lnov' }])] } }],
    ['missing confirmed title', tencentShow({ title: undefined })],
    ['duplicate matching introductions', { ret: 0, data: { CardList: [tencentCard('pc_introduction', [{ title: '完美世界', 'report.cid': 'mcv8hkc8zk8lnov' }, { title: '另一个标题', 'report.cid': 'mcv8hkc8zk8lnov' }])] } }],
  ];
  for (const [name, payload] of cases) await t.test(name, async () => {
    await assert.rejects(resolveOfficialMetadata({ url: tencentUrl, platform: 'tencent' }, {
      fetcher: async () => tencentResponse(payload),
    }), { code: 'UNSUPPORTED' });
  });
});

test('Tencent omits a non-HTTPS introduction image', async () => {
  const result = await resolveOfficialMetadata({ url: tencentUrl, platform: 'tencent' }, {
    fetcher: async () => tencentResponse(tencentShow({ new_pic_vt: 'http://img.example.test/cover.jpg', new_pic_hz: 'javascript:alert(1)' })),
  });
  assert.deepEqual(result, { title: '完美世界' });
});

test('Tencent video-page input requires a unique matching episode CID and matching introduction', async () => {
  const url = 'https://v.qq.com/x/page/x0036x5qqsr.html';
  const payload = { ret: 0, data: { CardList: [
    tencentCard('pc_web_episode_list', [{ cid: 'mcv8hkc8zk8lnov', vid: 'x0036x5qqsr', title: '1' }]),
    tencentCard('pc_introduction', [{ title: '完美世界', 'report.cid': 'mcv8hkc8zk8lnov' }]),
  ] } };
  const result = await resolveOfficialMetadata({ url, platform: 'tencent' }, {
    fetcher: async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body).page_params, {
        req_from: 'web_vsite', new_mark_label_enabled: '1', page_type: 'detail', page_id: 'detail', cid: '', vid: 'x0036x5qqsr',
      });
      return tencentResponse(payload);
    },
  });
  assert.deepEqual(result, { title: '完美世界' });
  for (const cards of [
    [tencentCard('pc_web_episode_list', [{ cid: 'mcv8hkc8zk8lnov', vid: 'other-video' }]), tencentCard('pc_introduction', [{ title: '完美世界', 'report.cid': 'mcv8hkc8zk8lnov' }])],
    [tencentCard('pc_web_episode_list', [{ cid: 'mcv8hkc8zk8lnov', vid: 'x0036x5qqsr' }, { cid: 'another123', vid: 'x0036x5qqsr' }]), tencentCard('pc_introduction', [{ title: '完美世界', 'report.cid': 'mcv8hkc8zk8lnov' }])],
    [tencentCard('pc_web_episode_list', [{ cid: 'mcv8hkc8zk8lnov', vid: 'x0036x5qqsr' }]), tencentCard('pc_introduction', [{ title: '无关节目', 'report.cid': 'another123' }])],
  ]) {
    await assert.rejects(resolveOfficialMetadata({ url, platform: 'tencent' }, {
      fetcher: async () => tencentResponse({ ret: 0, data: { CardList: cards } }),
    }), { code: 'UNSUPPORTED' });
  }
});

test('Tencent invalid API JSON reports INVALID_JSON through parse diagnostics', async () => {
  let report;
  await assert.rejects(resolveOfficialMetadata({ url: tencentUrl, platform: 'tencent' }, {
    reportFailure: value => { report = value; },
    fetcher: async () => response('{broken', 'application/json'),
  }), { code: 'INVALID_JSON' });
  assert.deepEqual(report, { event: 'guoman.metadata.failure', platform: 'tencent', stage: 'parse', code: 'INVALID_JSON' });
});

test('Tencent metadata decodes HTML entities and removes its platform suffix', async () => {
  const result = await resolveOfficialMetadata({ url: youkuUrl, platform: 'youku' }, {
    fetcher: async () => response('<meta property="og:title" content="星&amp;海 - 腾讯视频"><meta property="og:image" content="https://img.example.test/a.jpg">'),
  });

  assert.deepEqual(result, { title: '星&海', cover: 'https://img.example.test/a.jpg' });
});

test('Youku falls back to a bounded title element and strips the platform suffix', async () => {
  const result = await resolveOfficialMetadata({ url: 'https://v.youku.com/v_show/id_XMzEyMzQ1.html', platform: 'youku' }, {
    fetcher: async () => response('<html><title>海上来信_优酷</title></html>'),
  });

  assert.deepEqual(result, { title: '海上来信' });
});

test('reads the name title meta field and decodes numeric entities', async () => {
  const result = await resolveOfficialMetadata({ url: youkuUrl, platform: 'youku' }, {
    fetcher: async () => response('<meta name="title" content="&#x661F;海 &#38; 云 - 腾讯视频">'),
  });

  assert.deepEqual(result, { title: '星海 & 云' });
});

test('rejects a platform value that disagrees with the official URL without fetching', async () => {
  let fetched = false;
  await assert.rejects(resolveOfficialMetadata({ url: 'https://v.qq.com/x/cover/abc123.html', platform: 'bilibili' }, {
    fetcher: async () => { fetched = true; return response('{}', 'application/json'); },
  }), { code: 'INVALID_URL' });
  assert.equal(fetched, false);
});

test('rejects login, restricted, and generic service titles', async (t) => {
  for (const title of ['登录后观看 - 腾讯视频', '访问受限_优酷', '腾讯视频 - 不负好时光']) {
    await t.test(title, async () => {
      await assert.rejects(resolveOfficialMetadata({ url: youkuUrl, platform: 'youku' }, {
        fetcher: async () => response(`<meta property="og:title" content="${title}">`),
      }), { code: 'UNSUPPORTED' });
    });
  }
});

test('rejects platform-brand titles followed by official-site marketing copy', async (t) => {
  const cases = [
    [youkuUrl, 'youku', '腾讯视频 - 中国领先的在线视频媒体平台,海量高清视频在线观看'],
    [youkuUrl, 'youku', '优酷 - 为好内容全力以赴'],
  ];
  for (const [url, platform, title] of cases) {
    await t.test(title, async () => {
      await assert.rejects(resolveOfficialMetadata({ url, platform }, {
        fetcher: async () => response(`<meta property="og:title" content="${title}">`),
      }), { code: 'UNSUPPORTED' });
    });
  }
});

test('accepts a real show title followed by its platform name', async () => {
  const result = await resolveOfficialMetadata({ url: youkuUrl, platform: 'youku' }, {
    fetcher: async () => response('<meta property="og:title" content="某动漫 - 优酷">'),
  });

  assert.deepEqual(result, { title: '某动漫' });
});

test('Tencent metadata rejects redirects without following them', async () => {
  let calls = 0;
  let reports = 0;
  await assert.rejects(resolveOfficialMetadata({ url: tencentUrl, platform: 'tencent' }, {
    reportFailure: () => { reports += 1; },
    fetcher: async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: 'https://evil.example.test/title' } });
    },
  }), { code: 'REDIRECT_LIMIT' });
  assert.equal(calls, 1);
  assert.equal(reports, 1);
});

test('rejects non-text official responses', async () => {
  await assert.rejects(resolveOfficialMetadata({ url: tencentUrl, platform: 'tencent' }, {
    fetcher: async () => response('video', 'video/mp4'),
  }), { code: 'INVALID_CONTENT' });
});

test('enforces the configured response size limit', async () => {
  await assert.rejects(resolveOfficialMetadata({ url: tencentUrl, platform: 'tencent' }, {
    maxBytes: 10,
    fetcher: async () => response('<title>long enough</title>'),
  }), { code: 'BODY_TOO_LARGE' });
});

test('aborts a hanging official fetch at the configured timeout', async () => {
  const reports = [];
  await assert.rejects(resolveOfficialMetadata({ url: tencentUrl, platform: 'tencent' }, {
    timeoutMs: 10,
    reportFailure: (report) => reports.push(report),
    fetcher: (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }),
  }), { name: 'AbortError' });
  assert.deepEqual(reports, [{ event: 'guoman.metadata.failure', platform: 'tencent', stage: 'fetch', code: 'TIMEOUT' }]);
});

test('reports an HTTP failure with its numeric status and no raw details', async () => {
  let report;
  await assert.rejects(resolveOfficialMetadata({ url: tencentUrl, platform: 'tencent' }, {
    reportFailure: (value) => { report = value; },
    fetcher: async () => response('private response payload', 'text/html', 503),
  }), { code: 'HTTP_ERROR' });
  assert.deepEqual(report, { event: 'guoman.metadata.failure', platform: 'tencent', stage: 'fetch', code: 'HTTP_ERROR', status: 503 });
});

test('reports a missing title as a parse failure', async () => {
  let report;
  await assert.rejects(resolveOfficialMetadata({ url: tencentUrl, platform: 'tencent' }, {
    reportFailure: (value) => { report = value; },
    fetcher: async () => tencentResponse({ ret: 0, data: { CardList: [] } }),
  }), { code: 'UNSUPPORTED' });
  assert.deepEqual(report, { event: 'guoman.metadata.failure', platform: 'tencent', stage: 'parse', code: 'UNSUPPORTED' });
});

test('sanitizes unknown fetch errors and does not expose error text or stack', async () => {
  let report;
  const sensitiveError = Object.assign(new Error('secret-title account-token'), { code: 'SECRET_CODE' });
  sensitiveError.stack = 'secret-stack credential-value';
  await assert.rejects(resolveOfficialMetadata({ url: tencentUrl, platform: 'tencent' }, {
    reportFailure: (value) => { report = value; },
    fetcher: async () => { throw sensitiveError; },
  }), (error) => error === sensitiveError);
  assert.deepEqual(report, { event: 'guoman.metadata.failure', platform: 'tencent', stage: 'fetch', code: 'NETWORK_ERROR' });
  assert.equal(JSON.stringify(report).includes('secret'), false);
});

test('reports a body read abort as a fetch timeout and preserves the original error', async () => {
  const reports = [];
  const original = Object.assign(new Error('private body detail'), { name: 'AbortError' });
  const body = new ReadableStream({ start(controller) { controller.error(original); } });
  await assert.rejects(resolveOfficialMetadata({ url: tencentUrl, platform: 'tencent' }, {
    reportFailure: (report) => reports.push(report),
    fetcher: async () => new Response(body, { headers: { 'content-type': 'text/html' } }),
  }), (error) => error === original);
  assert.deepEqual(reports, [{ event: 'guoman.metadata.failure', platform: 'tencent', stage: 'fetch', code: 'TIMEOUT' }]);
});

test('reports an ordinary body read failure as a network error and preserves the original error', async () => {
  const reports = [];
  const original = Object.assign(new Error('secret response stream failure'), { code: 'SENSITIVE_CODE' });
  const body = new ReadableStream({ start(controller) { controller.error(original); } });
  await assert.rejects(resolveOfficialMetadata({ url: 'https://v.qq.com/x/cover/abc123.html', platform: 'tencent' }, {
    reportFailure: (report) => reports.push(report),
    fetcher: async () => new Response(body, { headers: { 'content-type': 'text/html' } }),
  }), (error) => error === original);
  assert.deepEqual(reports, [{ event: 'guoman.metadata.failure', platform: 'tencent', stage: 'fetch', code: 'NETWORK_ERROR' }]);
  assert.equal(JSON.stringify(reports).includes('secret'), false);
});

test('default diagnostics write one searchable JSON warning without sensitive fields', async () => {
  const originalWarn = console.warn;
  const calls = [];
  console.warn = (...args) => calls.push(args);
  try {
    await assert.rejects(resolveOfficialMetadata({ url: 'https://v.qq.com/x/cover/abc123.html', platform: 'tencent' }, {
      fetcher: async () => { throw new Error('secret title account token'); },
    }));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 1);
  assert.deepEqual(JSON.parse(calls[0][0]), {
    event: 'guoman.metadata.failure', platform: 'tencent', stage: 'fetch', code: 'NETWORK_ERROR',
  });
  assert.equal(calls[0][0].includes('secret'), false);
});

test('a diagnostic callback failure does not replace the original resolver error', async () => {
  const original = Object.assign(new Error('offline'), { code: 'NETWORK_ERROR' });
  await assert.rejects(resolveOfficialMetadata({ url: 'https://v.qq.com/x/cover/abc123.html', platform: 'tencent' }, {
    reportFailure: () => { throw new Error('logger failure'); },
    fetcher: async () => { throw original; },
  }), (error) => error === original);
});

test('invalid URLs and successful resolution do not report failures', async () => {
  let reports = 0;
  const options = { reportFailure: () => { reports += 1; }, fetcher: async () => response('<title>海上来信</title>') };
  await assert.rejects(resolveOfficialMetadata({ url: 'https://example.test/x', platform: 'tencent' }, options), { code: 'INVALID_URL' });
  assert.deepEqual(await resolveOfficialMetadata({ url: 'https://v.youku.com/v_show/id_XMzEyMzQ1.html', platform: 'youku' }, options), { title: '海上来信' });
  assert.equal(reports, 0);
});
