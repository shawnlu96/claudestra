import type { NextConfig } from "next";
import path from "node:path";

// commit 号不再从这里经 DefinePlugin 注入 —— 那是 webpack 持久缓存**看不见**的
// 隐藏输入,引用它的文件没改动时会复用旧 chunk,把上一次的 commit 带出来(2026-08-22
// owner「版本号还是不同」事故)。改由 scripts/gen-build-info.mjs 在 prebuild 落成
// lib/build-info.ts 源码文件,内容随 commit 变 → 缓存自然失效。splash 直接 import。

const nextConfig: NextConfig = {
  // 工作区根钉在 web/ 自己：不钉的话 Turbopack 看到仓库根的 bun.lock 就把整个仓库当根去扫，
  // 扫进 .claude/worktrees/*（agent 的隔离 worktree，node_modules 是软链回主树的）后判成
  // 「symlink 死循环」直接 panic，主树 build 失败（2026-09-23 实遇）。web 不 import 仓库根的任何东西。
  turbopack: { root: path.resolve(__dirname) },
  // better-sqlite3 / ssh2 是原生模块，不能被 bundler 打包，交给 Node require
  serverExternalPackages: ["better-sqlite3", "ssh2"],
  // v2.21.3+ 生产 source map:客户端错误栈(/api/client-log)只有压缩后的 chunk:行:列,
  // 组件名全是单字母,没有它定位不了 React #185 这类线上死循环。仓库本就开源,
  // .map 暴露无泄露顾虑;只多出 .map 文件,浏览器不主动下载,不影响加载体积。
  // 还原:node scripts/resolve-stack.mjs '<stack>'
  productionBrowserSourceMaps: true,
  // 允许经 Tailscale / 局域网 IP 访问 dev server 的 _next 资源（否则 Next 16 dev 对
  // 跨源 _next 请求告警，未来版本会直接拦）。手机走 Tailscale 测网页版时用得上。
  // 127.0.0.1：本机 Playwright 自动化测试——不在列表里 HMR websocket 握手会一直失败，
  // dev 页面周期性整页 reload（store 重挂、视图闪回空白），肉眼看着像灵异 bug。
  //
  // 自己的 tailnet IP / 局域网 IP / ts.net 主机名写进 .env.local 的 WEB_DEV_ORIGINS
  // （逗号分隔）。此前这里硬编码的是作者本人的三个地址，别人 clone 下来必须改源码
  // 才能用手机访问 dev server —— 那是最不该让用户碰的地方。
  // HTML 文档不许长缓存（2026-09-14 owner 反复「改了还是旧界面」的根因）：
  // 预渲染页默认发 `Cache-Control: s-maxage=31536000`，而 /_next/static 的 chunk 是
  // 内容哈希 + immutable ⇒ **旧 HTML 会一直指向旧 chunk，用户怎么刷都是旧构建**
  // （实测：Pi 徽章 / 用量分组反复「没出现」，服务端与构建产物都确认是对的）。
  // 文档改成 no-cache（仍带 ETag，命中就是 304，代价可忽略）；静态 chunk 一个字不动。
  // 只列真实页面，不写正则 —— 免得路径匹配在不同 Next 版本上翻车。
  async headers() {
    const noCache = [{ key: "Cache-Control", value: "no-cache, must-revalidate" }];
    return [
      { source: "/", headers: noCache },
      { source: "/chat", headers: noCache },
      { source: "/login", headers: noCache },
    ];
  },
  allowedDevOrigins: [
    "127.0.0.1",
    ...(process.env.WEB_DEV_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ],
};

export default nextConfig;
