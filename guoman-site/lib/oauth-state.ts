/** 校验十分钟内生成的一次性 OAuth state，调用方须先删除已存记录。 */
export function consumeOAuthState(
  record: string | null,
  returned: string | null,
  now = Date.now(),
) {
  if (!record || !returned) return false;
  try {
    const value = JSON.parse(record);
    return (
      typeof value.state === "string" &&
      value.state === returned &&
      Number.isFinite(value.createdAt) &&
      now >= value.createdAt &&
      now - value.createdAt < 10 * 60000
    );
  } catch {
    return false;
  }
}
