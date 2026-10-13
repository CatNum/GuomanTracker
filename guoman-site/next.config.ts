import type { NextConfig } from "next";
import { resolve } from "node:path";

const nextConfig: NextConfig = {
  // 前端与云函数共用的纯领域模块位于仓库上层目录。
  turbopack: { root: resolve(process.cwd(), "..") },
  outputFileTracingRoot: resolve(process.cwd(), ".."),
  ...(process.env.CLOUDBASE_STATIC_BUILD === "1"
    ? { output: "export", trailingSlash: true }
    : {}),

};

export default nextConfig;
