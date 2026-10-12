import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalogData } from '../lib/catalog-transport.ts';

const result = { items: [], live: false };

test('CloudBase guests keep the snapshot without making an anonymous request', async () => {
  let calls = 0;
  assert.equal(await loadCatalogData({ transport: 'cloudbase', accountReady: false, call: async () => { calls++; return result; } }), null);
  assert.equal(calls, 0);
});

test('CloudBase refresh calls the fixed getCatalog action and validates its result', async () => {
  let action = '';
  const data = await loadCatalogData({ transport: 'cloudbase', accountReady: true, call: async (name, payload) => { action = name; assert.deepEqual(payload, {}); return result; } });
  assert.equal(action, 'getCatalog');
  assert.deepEqual(data, result);
});

test('HTTP transport retains the public Next endpoint and rejects malformed results', async () => {
  let url = '';
  const fetchImpl = async (input: RequestInfo | URL) => { url = String(input); return new Response(JSON.stringify(result)); };
  assert.deepEqual(await loadCatalogData({ transport: 'http', accountReady: false, call: async () => { throw Error(); }, fetchImpl }), result);
  assert.equal(url, '/api/catalog');
  await assert.rejects(loadCatalogData({ transport: 'http', accountReady: false, call: async () => null, fetchImpl: async () => new Response('{}') }));
});
