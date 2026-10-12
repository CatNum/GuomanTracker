import test from 'node:test';
import assert from 'node:assert/strict';
import { isDefinitiveBusinessRejection, runLibraryOperation } from '../lib/library-operation.ts';
import { CloudActionError } from '../lib/cloud-auth.ts';

test('confirmed write stays successful when display refresh fails and recovery only reads', async () => {
  let writes = 0;
  let reads = 0;
  const result = await runLibraryOperation(
    async () => { writes++; return { version: 2 }; },
    async () => { reads++; throw new Error('read offline'); },
    () => false,
  );
  assert.equal(result.kind, 'saved-unrefreshed');
  await assert.rejects(async () => { reads++; throw new Error('still offline'); }, /offline/);
  assert.equal(writes, 1);
  assert.equal(reads, 2);
});

test('uncertain write never reads as saved or automatically retries', async () => {
  let writes = 0;
  let reads = 0;
  const result = await runLibraryOperation(
    async () => { writes++; throw new Error('response lost'); },
    async () => { reads++; return { version: 2 }; },
    () => false,
  );
  assert.equal(result.kind, 'unknown');
  assert.equal(writes, 1);
  assert.equal(reads, 0);
});

test('explicit business rejection remains correctable without a refresh', async () => {
  const rejection = Object.assign(new Error('集数不合法'), { code: 'INVALID_PROGRESS' });
  const result = await runLibraryOperation(
    async () => { throw rejection; },
    async () => { throw new Error('must not read'); },
    (error) => error === rejection,
  );
  assert.deepEqual(result, { kind: 'rejected', error: rejection });
});

test('only known business codes prove rejection; service failure and unknown commit require a read', () => {
  assert.equal(isDefinitiveBusinessRejection(new CloudActionError('版本冲突', 'CONFLICT')), true);
  assert.equal(isDefinitiveBusinessRejection(new CloudActionError('invalid', 'INVALID_PROGRESS')), true);
  assert.equal(isDefinitiveBusinessRejection(new CloudActionError('service failed', 'SERVICE_UNAVAILABLE')), false);
  assert.equal(isDefinitiveBusinessRejection(new CloudActionError('uncertain', 'TX_OUTCOME_UNKNOWN')), false);
  assert.equal(isDefinitiveBusinessRejection(new Error('network')), false);
});

test('unsupported platforms are correctable business rejections without an unknown-write lock', async () => {
  const rejection = new CloudActionError('目前仅支持哔哩哔哩、腾讯视频和优酷。', 'UNSUPPORTED_PLATFORM');
  let refreshes = 0;
  const result = await runLibraryOperation(
    async () => { throw rejection; },
    async () => { refreshes++; throw new Error('must not refresh'); },
    isDefinitiveBusinessRejection,
  );
  assert.deepEqual(result, { kind: 'rejected', error: rejection });
  assert.equal(refreshes, 0);
});
