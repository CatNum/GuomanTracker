import test from 'node:test';
import assert from 'node:assert/strict';
import * as catalog from '../lib/catalog-transport.ts';

test('public HTTP reads omit account credentials and return the page envelope', async () => {
  assert.equal(typeof catalog.fetchCatalogPage, 'function');
  const result = await catalog.fetchCatalogPage('https://catalog.example/api/catalog', 'getCatalog', { after: 'a' },
    async (url, options) => {
      assert.equal(url, 'https://catalog.example/api/catalog');
      assert.equal(options?.credentials, 'omit');
      assert.equal(options?.cache, 'no-store');
      assert.equal(options?.method, 'POST');
      assert.deepEqual(options?.headers, { 'Content-Type': 'application/json' });
      assert.deepEqual(JSON.parse(String(options?.body)), { action: 'getCatalog', payload: { after: 'a' } });
      return new Response(JSON.stringify({ ok: true, data: { items: [], nextAfter: '' } }));
    });
  assert.deepEqual(result, { items: [], nextAfter: '' });
});

test('public HTTP rejects writes before fetching and reports gateway or DB failures', async () => {
  assert.equal(typeof catalog.fetchCatalogPage, 'function');
  await assert.rejects(catalog.fetchCatalogPage('https://catalog.example/api/catalog', 'follow', {},
    async () => { throw Error('must not fetch'); }), /不支持/);
  for (const response of [new Response('{}', { status: 403 }), new Response('{'),
    new Response(JSON.stringify({ ok: false, error: { message: 'private SQL' } })), new Response('{}')]) {
    await assert.rejects(catalog.fetchCatalogPage('https://catalog.example/api/catalog', 'getCatalog', {},
      async () => response), /目录读取失败/);
  }
});
