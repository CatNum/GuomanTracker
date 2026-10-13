import test from 'node:test';
import assert from 'node:assert/strict';
import { readLibrarySnapshot, saveLibrarySnapshot, clearLibrarySnapshot } from '../lib/library-snapshot.ts';
import type { Library } from '../lib/watching.ts';
const library: Library = { user: { uid: 'alice', displayName: 'A' }, follows: [], series: [], priorityOrder: [], membershipVersion: 0, orderVersion: 0 };
function storage() {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } };
}
test('refresh snapshot is account-bound, expires, and is cleared on logout', () => {
  const store = storage();
  saveLibrarySnapshot(store, library, 1000);
  assert.deepEqual(readLibrarySnapshot(store, 'alice', 2000), library);
  assert.equal(readLibrarySnapshot(store, 'bob', 2000), null);
  assert.equal(readLibrarySnapshot(store, 'alice', 1000 + 3600000), null);
  clearLibrarySnapshot(store, 'alice');
  assert.equal(readLibrarySnapshot(store, 'alice', 2000), null);
});
test('corrupt, cross-account or unavailable storage never prevents cloud recovery', () => {
  const store = storage();
  saveLibrarySnapshot(store, library, 1000);
  const raw = store.getItem;
  store.getItem = key => raw(key)?.replace('alice', 'bob') ?? null;
  assert.equal(readLibrarySnapshot(store, 'alice', 2000), null);
  store.getItem = () => '{bad json';
  assert.equal(readLibrarySnapshot(store, 'alice', 2000), null);
  const unavailable = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.equal(readLibrarySnapshot(unavailable, 'alice', 2000), null);
  assert.doesNotThrow(() => saveLibrarySnapshot(unavailable, library, 1000));
  assert.doesNotThrow(() => clearLibrarySnapshot(unavailable, 'alice'));
});
