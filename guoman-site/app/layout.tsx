import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "国漫追更 · 现在看什么",
  description: "管理国漫追番和观看进度，找到已更新、还没看的故事，直达官方播放。",
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
