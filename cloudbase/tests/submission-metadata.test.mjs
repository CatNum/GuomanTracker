import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOfficialMetadata } from '../shared/submission-metadata.mjs';

function response(body, contentType = 'text/html; charset=utf-8', status = 200, headers = {}) {
  return new Response(body, { status, headers: { 'content-type': contentType, ...headers } });
}

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

test('Tencent metadata decodes HTML entities and removes its platform suffix', async () => {
  const result = await resolveOfficialMetadata({ url: 'https://v.qq.com/x/cover/abc123.html', platform: 'tencent' }, {
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
  const result = await resolveOfficialMetadata({ url: 'https://v.qq.com/x/cover/abc123.html', platform: 'tencent' }, {
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
      await assert.rejects(resolveOfficialMetadata({ url: 'https://v.qq.com/x/cover/abc123.html', platform: 'tencent' }, {
        fetcher: async () => response(`<meta property="og:title" content="${title}">`),
      }), { code: 'UNSUPPORTED' });
    });
  }
});

test('rejects platform-brand titles followed by official-site marketing copy', async (t) => {
  const cases = [
    ['https://v.qq.com/x/cover/abc123.html', 'tencent', '腾讯视频 - 中国领先的在线视频媒体平台,海量高清视频在线观看'],
    ['https://v.youku.com/v_show/id_XMzEyMzQ1.html', 'youku', '优酷 - 为好内容全力以赴'],
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
  const result = await resolveOfficialMetadata({ url: 'https://v.qq.com/x/cover/abc123.html', platform: 'tencent' }, {
    fetcher: async () => response('<meta property="og:title" content="某动漫 - 腾讯视频">'),
  });

  assert.deepEqual(result, { title: '某动漫' });
});

test('rejects a cross-platform redirect before following it', async () => {
  let calls = 0;
  let reports = 0;
  await assert.rejects(resolveOfficialMetadata({ url: 'https://v.qq.com/x/cover/abc123.html', platform: 'tencent' }, {
    reportFailure: () => { reports += 1; },
    fetcher: async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: 'https://evil.example.test/title' } });
    },
  }), { code: 'INVALID_URL' });
  assert.equal(calls, 1);
  assert.equal(reports, 0);
});

test('rejects non-text official responses', async () => {
  await assert.rejects(resolveOfficialMetadata({ url: 'https://v.qq.com/x/cover/abc123.html', platform: 'tencent' }, {
    fetcher: async () => response('video', 'video/mp4'),
  }), { code: 'INVALID_CONTENT' });
});

test('enforces the configured response size limit', async () => {
  await assert.rejects(resolveOfficialMetadata({ url: 'https://v.qq.com/x/cover/abc123.html', platform: 'tencent' }, {
    maxBytes: 10,
    fetcher: async () => response('<title>long enough</title>'),
  }), { code: 'BODY_TOO_LARGE' });
});

test('aborts a hanging official fetch at the configured timeout', async () => {
  const reports = [];
  await assert.rejects(resolveOfficialMetadata({ url: 'https://v.qq.com/x/cover/abc123.html', platform: 'tencent' }, {
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
  await assert.rejects(resolveOfficialMetadata({ url: 'https://v.qq.com/x/cover/abc123.html', platform: 'tencent' }, {
    reportFailure: (value) => { report = value; },
    fetcher: async () => response('private response payload', 'text/html', 503),
  }), { code: 'HTTP_ERROR' });
  assert.deepEqual(report, { event: 'guoman.metadata.failure', platform: 'tencent', stage: 'fetch', code: 'HTTP_ERROR', status: 503 });
});

test('reports a missing title as a parse failure', async () => {
  let report;
  await assert.rejects(resolveOfficialMetadata({ url: 'https://v.qq.com/x/cover/abc123.html', platform: 'tencent' }, {
    reportFailure: (value) => { report = value; },
    fetcher: async () => response('<html><body>page</body></html>'),
  }), { code: 'UNSUPPORTED' });
  assert.deepEqual(report, { event: 'guoman.metadata.failure', platform: 'tencent', stage: 'parse', code: 'UNSUPPORTED' });
});

test('sanitizes unknown fetch errors and does not expose error text or stack', async () => {
  let report;
  const sensitiveError = Object.assign(new Error('secret-title account-token'), { code: 'SECRET_CODE' });
  sensitiveError.stack = 'secret-stack credential-value';
  await assert.rejects(resolveOfficialMetadata({ url: 'https://v.qq.com/x/cover/abc123.html', platform: 'tencent' }, {
    reportFailure: (value) => { report = value; },
    fetcher: async () => { throw sensitiveError; },
  }), (error) => error === sensitiveError);
  assert.deepEqual(report, { event: 'guoman.metadata.failure', platform: 'tencent', stage: 'fetch', code: 'NETWORK_ERROR' });
  assert.equal(JSON.stringify(report).includes('secret'), false);
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
