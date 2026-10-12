/** Check that a cloud library snapshot belongs to the trusted SDK session. */
export function libraryBelongsToUser(library: unknown, userId: string): boolean {
  if (!library || typeof library !== "object") return false;
  const user = (library as { user?: unknown }).user;
  if (!user || typeof user !== "object") return false;
  return (user as { uid?: unknown }).uid === userId;
}
