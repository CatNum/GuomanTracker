import { CloudActionError } from './cloud-auth.ts';
import type { Library } from './watching.ts';

const rejectedCodes = new Set([
  'FOLLOW_LIMIT', 'INVALID_ACTION', 'INVALID_PROGRESS', 'INVALID_REQUEST',
  'INVALID_SERIES', 'INVALID_TITLE', 'INVALID_URL', 'NOT_FOLLOWING',
  'NOT_FOUND', 'RATE_LIMITED', 'UNAUTHENTICATED', 'UNSUPPORTED_PLATFORM', 'CONFLICT', 'INVALID_ORDER', 'ACCOUNT_CHANGED',
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
