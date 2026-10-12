/** Check that a cloud library snapshot belongs to the trusted SDK session. */
export function libraryBelongsToUser(library: unknown, userId: string): boolean {
  if (!library || typeof library !== "object") return false;
  const user = (library as { user?: unknown }).user;
  if (!user || typeof user !== "object") return false;
  return (user as { uid?: unknown }).uid === userId;
}

export type VerifiedSession = { userId: string; email?: string };

/** Read a library between two trusted sessions and bind the request to the first user. */
export async function readVerifiedLibrary<T>(
  readSession: () => Promise<VerifiedSession | null>,
  readLibrary: (expectedUserId: string) => Promise<T>,
  isCurrent: () => boolean = () => true,
): Promise<{ library: T; session: VerifiedSession } | null> {
  const before = await readSession();
  if (!isCurrent()) return null;
  if (!before) throw new Error("当前没有有效的邮箱账号会话，请重新登录。");
  const library = await readLibrary(before.userId);
  if (!isCurrent()) return null;
  const after = await readSession();
  if (!isCurrent()) return null;
  if (!after || after.userId !== before.userId || !libraryBelongsToUser(library, before.userId))
    throw new Error("账号会话已变化，未加载其他账号记录，请重新加载当前账号记录。");
  return { library, session: after };
}
