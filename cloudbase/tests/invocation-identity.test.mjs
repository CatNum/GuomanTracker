import test from 'node:test';
import assert from 'node:assert/strict';
import { readInvocationIdentity } from '../shared/invocation-identity.mjs';

const parse = (context) => context.environment
  ? { environment: JSON.parse(context.environment) }
  : { environ: Object.fromEntries(context.environ.split(';').filter(Boolean).map((item) => item.split('='))) };
const modern = (uid, flag = 'false') => ({ environment: JSON.stringify({ TCB_UUID: uid, TCB_ISANONYMOUS_USER: flag }) });

test('only an explicit nonanonymous invocation environment yields an identity', () => {
  assert.deepEqual(readInvocationIdentity(modern('alice'), parse), { uid: 'alice', isAnonymous: false });
  assert.deepEqual(readInvocationIdentity({ environment: JSON.stringify({ TCB_UUID: 'alice', TCB_ISANONYMOUS_USER: false }) }, parse), { uid: 'alice', isAnonymous: false });
  assert.deepEqual(readInvocationIdentity({ environ: 'TCB_UUID=bob;TCB_ISANONYMOUS_USER=false' }, parse), { uid: 'bob', isAnonymous: false });
  for (const bad of [
    undefined, null, {}, { environment: '' }, { environment: '{}', environ: 'TCB_UUID=bob;TCB_ISANONYMOUS_USER=false' },
    { environment: '{' }, { environment: 'null' }, { environment: '[]' },
    { environment: JSON.stringify({ TCB_UUID: 'alice' }) },
    { environment: JSON.stringify({ TCB_ISANONYMOUS_USER: 'false' }) },
    modern('alice', 'true'), modern(' alice'), modern('alice\n'), modern('a'.repeat(257)),
    { environ: 'TCB_UUID=bob;TCB_ISANONYMOUS_USER=true' },
  ]) assert.equal(readInvocationIdentity(bad, parse), null);
});

test('accessors, inherited identity, parser errors and malformed parser output fail closed', () => {
  const accessor = {};
  Object.defineProperty(accessor, 'environment', { get() { throw new Error('getter must not run'); } });
  assert.equal(readInvocationIdentity(accessor, parse), null);
  assert.equal(readInvocationIdentity(modern('alice'), () => { throw new Error('parse failed'); }), null);
  assert.equal(readInvocationIdentity(modern('alice'), () => ({ environment: Object.create({ TCB_UUID: 'alice', TCB_ISANONYMOUS_USER: false }) })), null);
  assert.equal(readInvocationIdentity(modern('alice'), () => ({ environment: { TCB_UUID: 'alice', TCB_ISANONYMOUS_USER: false }, environ: {} })), null);
  const getterIdentity = {};
  Object.defineProperty(getterIdentity, 'TCB_UUID', { get() { throw new Error('getter must not run'); } });
  getterIdentity.TCB_ISANONYMOUS_USER = false;
  assert.equal(readInvocationIdentity(modern('alice'), () => ({ environment: getterIdentity })), null);
});

test('SDK receives only a clean snapshot of the selected own context field', () => {
  const legacy = Object.create({ environment: JSON.stringify({ TCB_UUID: 'inherited-alice', TCB_ISANONYMOUS_USER: 'false' }) });
  legacy.environ = 'TCB_UUID=bob;TCB_ISANONYMOUS_USER=false';
  assert.deepEqual(readInvocationIdentity(legacy, parse), { uid: 'bob', isAnonymous: false });

  let getterCalls = 0;
  const rawModern = modernContextWithUnrelatedGetters();
  function modernContextWithUnrelatedGetters() {
    const value = modern('carol');
    for (const name of ['environ', 'request_id']) Object.defineProperty(value, name, { get() { getterCalls++; throw new Error('must not read unrelated field'); } });
    return value;
  }
  assert.deepEqual(readInvocationIdentity(rawModern, parse), { uid: 'carol', isAnonymous: false });
  assert.equal(getterCalls, 0);
});
