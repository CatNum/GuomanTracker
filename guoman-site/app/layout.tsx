import type { Metadata } from "next";
import "./globals.css";
import "@/components/anime-collection.css";
import "./anime-display.css";

export const metadata: Metadata = {
  title: "国漫追番 · 要看什么与新番周历",
  description: "抽取未看国漫、查看新番周历，管理真实追番和观看进度，直达官方播放。",
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
