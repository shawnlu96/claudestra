import type { NextConfig } from "next";
import path from "node:path";

// commit 号不再从这里经 DefinePlugin 注入 —— 那是 webpack 持久缓存**看不见**的隐藏输入,引用它的文件没改动时会复用旧 chunk,
// 把上一次的 commit 带出来(2026-08-22 owner「版本号还是不同」事故)。改由 scripts/gen-build-info.mjs 在 prebuild 落成
// lib/build-info.ts 源码文件,内容随 commit 变 → 缓存自然失效。

const nextConfig: NextConfig = {
  // 静态导出（docs/design-hosted-frontend.md §8.1）：没有服务端了——托管方（中继 RELAY_STATIC_DIR / bridge BRIDGE_STATIC_DIR）按导出布局
  // 服务 out/：`/chat` → chat.html、未知路径 → 404.html（src/lib/static-site.ts）。HTML 的缓存策略也由托管方定（这里没有 headers() 可用）。
  output: "export",
  images: { unoptimized: true },
  // 工作区根钉在 web/ 自己：不钉的话 Turbopack 看到仓库根的 bun.lock 就把整个仓库当根去扫，
  // 扫进 .claude/worktrees/*（agent 的隔离 worktree，node_modules 是软链回主树的）后判成
  // 「symlink 死循环」直接 panic，主树 build 失败（2026-09-23 实遇）。web 不 import 仓库根的任何东西。
  turbopack: { root: path.resolve(__dirname) },
  // 生产 source map:客户端错误栈(/api/v1/client-log)只有压缩后的 chunk:行:列,组件名全是单字母,
  // 没有它定位不了 React #185 这类线上死循环。仓库本就开源,.map 暴露无泄露顾虑;浏览器不主动下载。
  // 还原:node scripts/resolve-stack.mjs '<stack>'
  productionBrowserSourceMaps: true,
  // dev server 的额外放行来源：自己的 tailnet IP / 局域网 IP / ts.net 主机名写进 .env.local 的 WEB_DEV_ORIGINS（逗号分隔）。
  // 127.0.0.1：本机 Playwright 自动化测试——不在列表里 HMR websocket 握手会一直失败，dev 页面周期性整页 reload。
  allowedDevOrigins: [
    "127.0.0.1",
    ...(process.env.WEB_DEV_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ],
};

export default nextConfig;
