import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "国漫追更 · 主流平台国漫合集",
  description: "汇集主流视频平台国漫，查看更新时间并直达官方播放。",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
