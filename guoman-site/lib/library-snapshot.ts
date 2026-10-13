import type { Library } from './watching.ts';
import { libraryBelongsToUser } from './library-identity.ts';
type SnapshotStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = (uid: string) => `guoman-library-snapshot-v1:${uid}`;
const maxAge = 15 * 60 * 1000;

/** Display-only snapshot: read only after SDK identity verification, never authorize writes from it. */
export function readLibrarySnapshot(storage: SnapshotStorage, uid: string, now = Date.now()): Library | null {
  try {
    const raw = storage.getItem(key(uid));
    if (!raw) return null;
    const snapshot = JSON.parse(raw);
    const data = snapshot.library as Library;
    if (!Number.isFinite(snapshot.at) || snapshot.at > now || now - snapshot.at > maxAge || !libraryBelongsToUser(data, uid) ||
        !Array.isArray(data.follows) || !Array.isArray(data.series) || !Array.isArray(data.priorityOrder) ||
        !Number.isSafeInteger(data.membershipVersion) || !Number.isSafeInteger(data.orderVersion) ||
        !data.follows.every(f => f && typeof f.seriesId === 'string' && Number.isSafeInteger(f.currentEpisode) && typeof f.episodeCompleted === 'boolean' && typeof f.paused === 'boolean' && Number.isSafeInteger(f.version)) ||
        !data.series.every(s => s && ['id', 'title', 'platform', 'url', 'cover', 'status', 'episodes', 'checkedAt', 'source'].every(field => typeof s[field as keyof typeof s] === 'string') && Array.isArray(s.events) && s.events.every(e => e && Number.isFinite(e.at) && typeof e.label === 'string')) ||
        !data.priorityOrder.every(id => typeof id === 'string')) return null;
    return data;
  } catch { return null; }
}
export function saveLibrarySnapshot(storage: SnapshotStorage, library: Library, now = Date.now()): void {
  try { storage.setItem(key(library.user.uid), JSON.stringify({ at: now, library })); } catch { /* Storage is optional. */ }
}
export function clearLibrarySnapshot(storage: SnapshotStorage, uid: string): void {
  try { storage.removeItem(key(uid)); } catch { /* Storage is optional. */ }
}
