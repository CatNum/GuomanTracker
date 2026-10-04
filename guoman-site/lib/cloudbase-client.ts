"use client";
import { consumeOAuthState } from "./oauth-state";

const env = process.env.NEXT_PUBLIC_CLOUDBASE_ENV_ID;
const region = process.env.NEXT_PUBLIC_CLOUDBASE_REGION || "ap-shanghai";
const accessKey = process.env.NEXT_PUBLIC_CLOUDBASE_PUBLISHABLE_KEY;
export const cloudConfigured = !!env && !/PLACEHOLDER|YOUR_|<|>/i.test(env);
let appPromise: Promise<import("@cloudbase/js-sdk").app.App> | undefined;
export async function cloudApp() {
  if (!cloudConfigured)
    throw new Error("微信登录尚未配置。可以先体验本机演示。");
  return (appPromise ??= import("@cloudbase/js-sdk").then(
    ({ default: cloudbase }) =>
      cloudbase.init({
        env,
        region,
        ...(accessKey && !/PLACEHOLDER|YOUR_/i.test(accessKey)
          ? { accessKey }
          : {}),
      }),
  ));
}
export async function cloudCall(
  action: string,
  payload: Record<string, unknown> = {},
) {
  const app = await cloudApp();
  const response = await app.callFunction({
    name: "guoman-user",
    data: { action, payload },
  });
  const result =
    typeof response.result === "string"
      ? JSON.parse(response.result)
      : response.result;
  if (!result || typeof result !== "object" || !("ok" in result))
    throw new Error("云服务响应异常，请稍后再试");
  const envelope = result as {
    ok: boolean;
    data?: unknown;
    error?: { code: string; message: string };
  };
  if (!envelope.ok)
    throw new Error(envelope.error?.message || "操作未完成，请稍后再试");
  return envelope.data;
}
export async function beginWechatLogin() {
  const app = await cloudApp();
  const state = Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
  sessionStorage.setItem(
    "guoman-wechat-state",
    JSON.stringify({ state, createdAt: Date.now() }),
  );
  const { uri } = await app
    .auth()
    .genProviderRedirectUri({
      provider_id: "wx_open",
      provider_redirect_uri: location.origin + "/auth/wechat/callback",
      state,
    });
  const target = new URL(uri);
  if (target.protocol !== "https:")
    throw new Error("授权地址异常，请检查微信登录配置");
  location.assign(target.href);
}
export async function finishWechatLogin(search: string) {
  const params = new URLSearchParams(search),
    code = params.get("code"),
    state = params.get("state");
  const record = sessionStorage.getItem("guoman-wechat-state");
  sessionStorage.removeItem("guoman-wechat-state");
  if (!code || !consumeOAuthState(record, state))
    throw new Error("授权已失效或来源不匹配，请重新发起微信登录");
  const app = await cloudApp();
  const { provider_token } = await app
    .auth()
    .grantProviderToken({
      provider_id: "wx_open",
      provider_redirect_uri: location.origin + "/auth/wechat/callback",
      provider_code: code,
    });
  try {
    await app.auth().signInWithProvider({ provider_token });
  } catch (error) {
    if (String((error as { error?: string })?.error) === "not_found")
      throw new Error(
        "尚未建立微信账号。请管理员检查 CloudBase 微信身份源的注册模式，或完成账号绑定。",
      );
    throw new Error("微信登录未完成，请检查身份源和回调域名配置");
  }
  localStorage.removeItem("guoman-demo-enabled");
}
