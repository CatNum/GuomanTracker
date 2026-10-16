import test from 'node:test';
import assert from 'node:assert/strict';
import * as catalog from '../shared/catalog-service.mjs';

const request = (body, extra = {}) => ({ httpMethod: 'POST', path: '/api/catalog',
  body: JSON.stringify(body), isBase64Encoded: false, ...extra });
const read = { action: 'getCatalog', payload: { after: '' } };

test('HTTP guest catalog reads PG and keeps the public field boundary', async () => {
  assert.equal(typeof catalog.createCatalogHttpHandler, 'function');
  const handler = catalog.createCatalogHttpHandler({ createStore: () => ({
    listSeriesPage: async () => ({ documents: [{ id: 'a', title: 'PG节目', platform: 'bilibili', owner: 'private' }], next_after: '' }),
  }) });
  const response = await handler(request(read));
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Access-Control-Allow-Origin'], '*');
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.deepEqual(JSON.parse(response.body).data.items, [{ id: 'a', title: 'PG节目', platform: 'bilibili' }]);
  assert.equal((await handler(request(read, { path: '/' }))).statusCode, 200);
});

test('HTTP preflight, wrong methods, paths, writes and malformed bodies never access PG', async () => {
  assert.equal(typeof catalog.createCatalogHttpHandler, 'function');
  let accesses = 0;
  const handler = catalog.createCatalogHttpHandler({ createStore: () => { accesses++; throw Error('private'); } });
  assert.equal((await handler(request(read, { httpMethod: 'OPTIONS' }))).statusCode, 204);
  for (const event of [request(read, { httpMethod: 'GET' }), request(read, { path: '/api/catalog/other' }),
    request({ action: 'follow', payload: {} }), request({ action: 'getCatalog', payload: { owner: 'alice' } }),
    request(read, { body: '{' }), request(read, { body: 'x'.repeat(4097) }), request(read, { isBase64Encoded: true })]) {
    assert.ok((await handler(event)).statusCode >= 400);
  }
  assert.equal(accesses, 0);
});

test('HTTP database failure is a retryable 503 without SQL details', async () => {
  assert.equal(typeof catalog.createCatalogHttpHandler, 'function');
  const handler = catalog.createCatalogHttpHandler({ createStore: () => { throw Error('private SQL'); } });
  const response = await handler(request(read));
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).error.code, 'SERVICE_UNAVAILABLE');
  assert.doesNotMatch(response.body, /private SQL/);
});
