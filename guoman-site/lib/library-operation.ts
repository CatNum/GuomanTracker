import { CloudActionError } from './cloud-auth.ts';

const rejectedCodes = new Set([
  'FOLLOW_LIMIT', 'INVALID_ACTION', 'INVALID_PROGRESS', 'INVALID_REQUEST',
  'INVALID_SERIES', 'INVALID_TITLE', 'INVALID_URL', 'NOT_FOLLOWING',
  'NOT_FOUND', 'RATE_LIMITED', 'UNAUTHENTICATED', 'CONFLICT',
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

/** A confirmed write remains confirmed even if the following read fails. */
export async function runLibraryOperation<T>(
  write: () => Promise<unknown>,
  refresh: () => Promise<T>,
  isRejected: (error: unknown) => boolean,
): Promise<LibraryOperationResult<T>> {
  try { await write(); }
  catch (error) { return isRejected(error) ? { kind: 'rejected', error } : { kind: 'unknown', error }; }
  try { return { kind: 'saved', library: await refresh() }; }
  catch (error) { return { kind: 'saved-unrefreshed', error }; }
}
