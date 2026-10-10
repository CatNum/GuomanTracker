import test from "node:test";
import assert from "node:assert/strict";
import {
  getAuthenticatedSession,
  inspectAuthenticatedSession,
  sendEmailCode,
  verifyEmailCode,
  callAuthenticated,
  emailErrorMessage,
  emailRetryDelayMs,
} from "../lib/cloud-auth.ts";
import { endCloudSession, readDemoSelection } from "../lib/account-actions.ts";

const session = { data: { session: { user: { id: "user-1", is_anonymous: false } } }, error: null };

test("公开凭证、匿名及形状异常会话不能调用云函数", async () => {
  for (const result of [
    { data: { session: null }, error: null },
    { data: { session: { user: { id: "anonymous", is_anonymous: true } } }, error: null },
    { data: { user: { id: "user-1", is_anonymous: false } }, error: null },
    { data: { session: { user: { id: "user-1" } } }, error: null },
  ]) {
    let called = false;
    const auth = { getSession: async () => result };
    assert.equal(await getAuthenticatedSession(auth), null);
    await assert.rejects(() => callAuthenticated(auth, async () => { called = true; return { result: { ok: true, data: {} } }; }, "library", {}), /登录/);
    assert.equal(called, false);
  }
});

test("会话查询 resolve 错误阻断用户库请求", async () => {
  let called = false;
  await assert.rejects(() => callAuthenticated(
    { getSession: async () => ({ data: null, error: { message: "network" } }) },
    async () => { called = true; return { result: {} }; }, "library", {},
  ), /会话/);
  assert.equal(called, false);
});

test("冷启动会话查询失败标记账号状态未确认，空会话仍是普通访客", async () => {
  const failed = await inspectAuthenticatedSession(async () => { throw new Error("offline"); });
  assert.equal(failed.session, null);
  assert.equal(failed.uncertain, true);
  assert.match(String(failed.error), /offline/);

  const guest = await inspectAuthenticatedSession(async () => null);
  assert.equal(guest.session, null);
  assert.equal(guest.uncertain, false);
  assert.equal(guest.error, null);
});

test("已有 SDK 登录在冷启动查询失败时仍可明确退出，不遗留会话", async () => {
  let sdkSignedIn = true;
  const inspected = await inspectAuthenticatedSession(async () => {
    throw new Error("temporary session failure");
  });
  assert.equal(inspected.uncertain, true);
  await endCloudSession({ signOut: async () => {
    sdkSignedIn = false;
    return { data: {}, error: null };
  } }, () => {});
  assert.equal(sdkSignedIn, false);
});

test("验证码发送使用智能注册回调，验证后要求真实会话", async () => {
  let sent = "";
  let token = "";
  const auth = {
    signInWithOtp: async (input: { email: string; options: { shouldCreateUser: boolean } }) => {
      sent = `${input.email}:${input.options.shouldCreateUser}`;
      return { data: { verifyOtp: async (input: { token: string }) => { token = input.token; return { data: {}, error: null }; } }, error: null };
    },
    getSession: async () => session,
  };
  const challenge = await sendEmailCode(auth, "  a@example.com  ");
  assert.equal(sent, "a@example.com:true");
  assert.equal(challenge.email, "a@example.com");
  assert.equal((await verifyEmailCode(auth, challenge, " 123456 ")).userId, "user-1");
  assert.equal(token, "123456");
});

test("发码与验码 resolve 错误、缺回调、缺真实用户均失败", async () => {
  await assert.rejects(() => sendEmailCode({ signInWithOtp: async () => ({ data: null, error: { message: "send failed" } }) }, "a@example.com"), /send failed/);
  await assert.rejects(() => sendEmailCode({ signInWithOtp: async () => ({ data: {}, error: null }) }, "a@example.com"), /验证码/);
  const challenge = { email: "a@example.com", verify: async () => ({ data: null, error: { message: "wrong code" } }) };
  await assert.rejects(() => verifyEmailCode({ getSession: async () => session }, challenge, "123456"), /wrong code/);
  await assert.rejects(() => verifyEmailCode({ getSession: async () => ({ data: { session: null }, error: null }) }, { ...challenge, verify: async () => ({ data: {}, error: null }) }, "123456"), /会话/);
});

test("频控错误单独提示，普通网络错误保留其原意", () => {
  assert.match(emailErrorMessage({ category: "RATE_LIMITED" }), /环境每分钟最多发送 10 封/);
  assert.match(emailErrorMessage({ code: "resource_exhausted" }), /发送过于频繁/);
  assert.equal(emailErrorMessage({ message: "网络不可用" }), "网络不可用");
});

test("所有已识别频控代码均启动冷却，正有限重试秒数生效", () => {
  for (const code of ["rate_limited", "TOO_MANY_REQUESTS", "resource_exhausted"])
    assert.equal(emailRetryDelayMs({ code }), 60000);
  assert.equal(emailRetryDelayMs({ category: "RATE_LIMITED", retryAfter: 17 }), 17000);
  assert.equal(emailRetryDelayMs({ code: "rate_limited", retryAfter: -3 }), 60000);
  assert.equal(emailRetryDelayMs({ code: "rate_limited", retryAfter: Infinity }), 60000);
  assert.equal(emailRetryDelayMs({ message: "network failed" }), null);
});

test("正式会话调用云函数仍验证业务信封", async () => {
  const auth = { getSession: async () => session };
  assert.deepEqual(await callAuthenticated(auth, async () => ({ result: { ok: true, data: { follows: [] } } }), "library", {}), { follows: [] });
  await assert.rejects(() => callAuthenticated(auth, async () => ({ result: { ok: false, error: { message: "denied" } } }), "library", {}), /denied/);
});

test("验证码回调成功后会话查询失败仍标记待恢复，可重试而无需再次发码", async () => {
  let accepted = false;
  let sends = 0;
  const auth = {
    signInWithOtp: async () => {
      sends++;
      return { data: { verifyOtp: async () => ({ data: {}, error: null }) }, error: null };
    },
    getSession: async () => { throw new Error("session network failed"); },
  };
  const challenge = await sendEmailCode(auth, "a@example.com");
  await assert.rejects(() => verifyEmailCode(auth, challenge, "123456", () => { accepted = true; }), /session network failed/);
  assert.equal(accepted, true);
  assert.equal(sends, 1);
  const restored = await callAuthenticated<{ follows: unknown[] }>(
    { getSession: async () => session },
    async () => ({ result: { ok: true, data: { follows: [] } } }), "library", {},
  );
  assert.deepEqual(restored.follows, []);
  assert.equal(sends, 1);
});

test("验证码已持久化 SDK 会话但查询失败时，明确退出会清掉 SDK 会话", async () => {
  let sdkSignedIn = false;
  let sessionAvailable = false;
  let pending = false;
  const auth = {
    getSession: async () => {
      if (!sessionAvailable) return { data: null, error: { message: "session unavailable" } };
      return sdkSignedIn ? session : { data: { session: null }, error: null };
    },
    signOut: async () => { sdkSignedIn = false; sessionAvailable = true; return { data: {}, error: null }; },
  };
  await assert.rejects(() => verifyEmailCode(auth,
    { email: "a@example.com", verify: async () => { sdkSignedIn = true; return { data: {}, error: null }; } },
    "123456", () => { pending = true; },
  ), /会话查询失败/);
  assert.equal(sdkSignedIn, true);
  assert.equal(pending, true);
  await endCloudSession(auth, () => { pending = false; });
  assert.equal(pending, false);
  assert.equal(sdkSignedIn, false);
  assert.equal(await getAuthenticatedSession(auth), null);
});

test("错误验证码不会标记待恢复；已落会话的退出 resolve 错误保留待恢复状态", async () => {
  let accepted = false;
  await assert.rejects(() => verifyEmailCode(
    { getSession: async () => ({ data: { session: null }, error: null }) },
    { email: "a@example.com", verify: async () => ({ data: null, error: { message: "wrong code" } }) },
    "000000", () => { accepted = true; },
  ), /wrong code/);
  assert.equal(accepted, false);

  let pending = true;
  await assert.rejects(() => endCloudSession(
    { signOut: async () => ({ error: { message: "network" } }) },
    () => { pending = false; },
  ), /退出未完成/);
  assert.equal(pending, true);
});

test("SDK 验证回调返回错误但已持久化会话时仍标记待恢复", async () => {
  let accepted = false;
  await assert.rejects(() => verifyEmailCode(
    { getSession: async () => session },
    { email: "a@example.com", verify: async () => ({ data: null, error: { message: "late failure" } }) },
    "123456", () => { accepted = true; },
  ), /late failure/);
  assert.equal(accepted, true);
});

test("浏览器存储拒绝读取演示标记时恢复访客且不修改本机记录", () => {
  let writes = 0;
  const storage = {
    getItem: () => { throw new DOMException("blocked", "SecurityError"); },
    setItem: () => { writes++; },
    removeItem: () => { writes++; },
  };
  const selection = readDemoSelection(storage);
  assert.equal(selection.selected, false);
  assert.match(selection.error || "", /存储/);
  assert.equal(writes, 0);
});
