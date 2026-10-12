/** The SDK's v3 auth declarations are incomplete in the installed package. */
export type SessionAuth = {
  getSession(): Promise<unknown>;
};
export type EmailAuth = SessionAuth & {
  signInWithOtp(input: { email: string; options: { shouldCreateUser: true } }): Promise<unknown>;
};
export type EmailChallenge = {
  email: string;
  verify(input: { token: string }): Promise<unknown>;
};

/** A business envelope returned by the server, with its safe error code. */
export class CloudActionError extends Error {
  code: string | null;
  constructor(message: string, code: unknown) {
    super(message);
    this.name = 'CloudActionError';
    this.code = typeof code === 'string' && /^[A-Z_]{2,40}$/.test(code) ? code : null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function resultError(value: unknown): unknown {
  return record(value)?.error;
}

function rateLimited(error: unknown): boolean {
  const value = record(error);
  return value?.category === "RATE_LIMITED" ||
    ["resource_exhausted", "rate_limited", "too_many_requests"].includes(String(value?.code || "").toLowerCase());
}

export function emailRetryDelayMs(error: unknown): number | null {
  if (!rateLimited(error)) return null;
  const retryAfter = record(error)?.retryAfter;
  return typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfter * 1000 : 60000;
}

export function emailErrorMessage(error: unknown): string {
  const value = record(error);
  if (rateLimited(error))
    return "邮件发送过于频繁，环境每分钟最多发送 10 封，请稍后重试。";
  return typeof value?.message === "string" && value.message
    ? value.message : error instanceof Error ? error.message : "操作未完成，请稍后重试。";
}

function throwResultError(value: unknown, context: string) {
  const error = resultError(value);
  if (error) {
    const details = record(error);
    throw Object.assign(new Error(`${context}：${emailErrorMessage(error)}`), {
      code: details?.code, category: details?.category, retryAfter: details?.retryAfter,
    });
  }
}

/** Only a non-anonymous v3 session is a signed-in account. */
export async function getAuthenticatedSession(auth: SessionAuth): Promise<{ userId: string; email?: string } | null> {
  const result = await auth.getSession();
  throwResultError(result, "会话查询失败");
  const user = record(record(record(result)?.data)?.session)?.user;
  const details = record(user);
  return typeof details?.id === "string" && details.id.trim() && details.is_anonymous === false
    ? { userId: details.id, ...(typeof details.email === "string" && details.email.trim() ? { email: details.email } : {}) } : null;
}

/** A failed session lookup leaves the SDK's persisted login state unknown. */
export async function inspectAuthenticatedSession(check: () => Promise<{ userId: string; email?: string } | null>): Promise<{
  session: { userId: string; email?: string } | null;
  uncertain: boolean;
  error: unknown;
}> {
  try { return { session: await check(), uncertain: false, error: null }; }
  catch (error) { return { session: null, uncertain: true, error }; }
}

export async function sendEmailCode(auth: Pick<EmailAuth, "signInWithOtp">, email: string): Promise<EmailChallenge> {
  const normalized = email.trim();
  if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized))
    throw new Error("请输入有效的邮箱地址。");
  const result = await auth.signInWithOtp({ email: normalized, options: { shouldCreateUser: true } });
  throwResultError(result, "发送验证码失败");
  const verify = record(record(result)?.data)?.verifyOtp;
  if (typeof verify !== "function") throw new Error("验证码发送状态异常，请稍后重试。");
  return { email: normalized, verify: verify as EmailChallenge["verify"] };
}

export async function verifyEmailCode(auth: SessionAuth, challenge: EmailChallenge, token: string, onSessionMayExist?: () => void): Promise<{ userId: string; email?: string }> {
  try {
    const result = await challenge.verify({ token: token.trim() });
    throwResultError(result, "验证码校验失败");
  } catch (error) {
    // The SDK can persist a session before reporting a later verification error.
    try {
      if (await getAuthenticatedSession(auth)) onSessionMayExist?.();
    } catch {
      // A failed session query cannot prove that the SDK did not persist it.
      onSessionMayExist?.();
    }
    throw error;
  }
  onSessionMayExist?.();
  const session = await getAuthenticatedSession(auth);
  if (!session) throw new Error("验证码已提交，但未取得正式账号会话，请重试。");
  return session;
}

export async function callAuthenticated<T>(
  auth: SessionAuth,
  invoke: (action: string, payload: Record<string, unknown>) => Promise<{ result?: unknown }>,
  action: string,
  payload: Record<string, unknown>,
): Promise<T> {
  if (!await getAuthenticatedSession(auth)) throw new Error("请先登录邮箱账号，再使用云端追番记录。");
  const response = await invoke(action, payload);
  const value = typeof response.result === "string" ? JSON.parse(response.result) : response.result;
  const envelope = record(value);
  if (typeof envelope?.ok !== "boolean") throw new Error("云服务响应异常，请稍后再试。");
  if (!envelope.ok) {
    const error = record(envelope.error);
    throw new CloudActionError(String(error?.message || "操作未完成，请稍后再试。"), error?.code);
  }
  return envelope.data as T;
}
