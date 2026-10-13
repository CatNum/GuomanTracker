import { CloudActionError } from './cloud-auth.ts';
import type { Library, WatchState } from './watching.ts';

const rejectedCodes = new Set([
  'FOLLOW_LIMIT', 'INVALID_ACTION', 'INVALID_PROGRESS', 'INVALID_REQUEST',
  'INVALID_SERIES', 'INVALID_TITLE', 'INVALID_URL', 'NOT_FOLLOWING',
  'NOT_FOUND', 'RATE_LIMITED', 'UNAUTHENTICATED', 'UNSUPPORTED_PLATFORM', 'CONFLICT', 'INVALID_ORDER', 'ACCOUNT_CHANGED',
  'METADATA_UNAVAILABLE',
]);

/** Only known business denials prove that the server declined the write. */
export function isDefinitiveBusinessRejection(error: unknown): boolean {
  return error instanceof CloudActionError && rejectedCodes.has(error.code || '');
}

export type LibraryOperationResult<T> =
  | { kind: 'saved'; library: T }
  | { kind: 'saved-unrefreshed'; error: unknown }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'unknown'; error: unknown };

/** Apply a complete server-confirmed reorder without reading the library again. */
export function applyConfirmedReorder(library: Library, expectedOrder: string[], value: unknown): Library | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.priorityOrder) || !result.priorityOrder.every((id) => typeof id === 'string') ||
      result.priorityOrder.length !== expectedOrder.length || result.priorityOrder.some((id, index) => id !== expectedOrder[index]) ||
      result.membershipVersion !== (library.membershipVersion ?? 0) || result.orderVersion !== (library.orderVersion ?? 0) + 1) return null;
  return {
    ...library,
    priorityOrder: [...result.priorityOrder],
    membershipVersion: result.membershipVersion as number,
    orderVersion: result.orderVersion as number,
  };
}

/** A confirmed write remains confirmed even if the following read fails. */
export async function runLibraryOperation<T>(
  write: () => Promise<unknown>,
  refresh: () => Promise<T>,
  isRejected: (error: unknown) => boolean,
  confirmedResult?: (writeResult: unknown) => T | null | Promise<T | null>,
): Promise<LibraryOperationResult<T>> {
  let writeResult: unknown;
  try { writeResult = await write(); }
  catch (error) { return isRejected(error) ? { kind: 'rejected', error } : { kind: 'unknown', error }; }
  try {
    const confirmed = await confirmedResult?.(writeResult);
    if (confirmed !== null && confirmed !== undefined) return { kind: 'saved', library: confirmed };
    return { kind: 'saved', library: await refresh() };
  }
  catch (error) { return { kind: 'saved-unrefreshed', error }; }
}

/** Apply a committed membership change only when its baseline still matches this account snapshot. */
export function applyConfirmedMembership(library: Library, action: 'follow' | 'unfollow', seriesId: string, value: unknown): Library | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Record<string, unknown>;
  const patch = result.libraryPatch as Record<string, unknown> | undefined;
  const exists = library.follows.some(follow => follow.seriesId === seriesId);
  const changed = action === 'follow' ? !exists : exists;
  if (result.seriesId !== seriesId || !patch ||
      patch.beforeMembershipVersion !== library.membershipVersion || patch.beforeOrderVersion !== library.orderVersion ||
      patch.membershipVersion !== library.membershipVersion + Number(changed) || patch.orderVersion !== library.orderVersion ||
      !Array.isArray(patch.priorityOrder) || !patch.priorityOrder.every(id => typeof id === 'string')) return null;
  const members = new Set(library.follows.map(follow => follow.seriesId));
  if (action === 'follow') members.add(seriesId); else members.delete(seriesId);
  if (patch.priorityOrder.length !== members.size || new Set(patch.priorityOrder).size !== members.size ||
      patch.priorityOrder.some(id => !members.has(id))) return null;
  let follows = library.follows.filter(follow => follow.seriesId !== seriesId);
  let series = library.series.filter(item => item.id !== seriesId);
  if (action === 'follow') {
    const item = result.series as Library['series'][number] | undefined;
    if (!item || item.id !== seriesId || typeof item.title !== 'string' || typeof item.platform !== 'string' || !Array.isArray(item.events) ||
        !Number.isSafeInteger(result.version) || (result.version as number) < 1 ||
        !Number.isSafeInteger(result.currentEpisode) || (result.currentEpisode as number) < 0 ||
        typeof result.episodeCompleted !== 'boolean' || typeof result.paused !== 'boolean' || typeof result.updatedAt !== 'string') return null;
    const follow: WatchState = { seriesId, currentEpisode: result.currentEpisode as number, episodeCompleted: result.episodeCompleted,
      paused: result.paused, updatedAt: result.updatedAt, version: result.version as number,
      ...(typeof result.lastOpenedAt === 'string' ? { lastOpenedAt: result.lastOpenedAt } : {}) };
    follows = [...follows, follow];
    series = [...series, item];
  }
  return { ...library, follows, series, priorityOrder: [...patch.priorityOrder] as string[],
    membershipVersion: patch.membershipVersion as number, orderVersion: patch.orderVersion as number };
}
