"use client";
import { useEffect, useRef, useState } from "react";
import { finishWechatLogin } from "@/lib/cloudbase-client";
export default function WechatCallback() {
  const started = useRef(false);
  const [message, setMessage] = useState("正在验证微信授权…");
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void finishWechatLogin(location.search)
      .then(() => location.replace("/"))
      .catch((error) => {
        history.replaceState(null, "", location.pathname);
        setMessage(error instanceof Error ? error.message : "微信登录未完成");
      });
  }, []);
  return (
    <main className="auth-result">
      <span className="eyebrow">国漫追更 · 微信登录</span>
      <h1>{message}</h1>
      <a className="primary-action" href="/">
        返回首页
      </a>
    </main>
  );
}
