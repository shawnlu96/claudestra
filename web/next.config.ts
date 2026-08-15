import type { NextConfig } from "next";
import { execSync } from "child_process";

// 构建时把 commit 烤进客户端 bundle(owner 2026-07-27:「你对一下版本不就好了」)。
// /api/version 只能证明服务端在跑什么;PWA 的 SW 缓存会让客户端 JS 悄悄滞后,
// 两个号并排显示,缓存漂移一眼可见。
let clientCommit = "";
let clientWebCommit = "";
try {
  clientCommit = execSync("git rev-parse --short HEAD", { cwd: __dirname }).toString().trim();
  // v2.19.0:滞后判据从「HEAD」换成「最后一个动过 web/ 的 commit」。
  // 用 HEAD 比对时,任何只改 src/ 的后端提交都会让开屏页亮黄字「本地 xxx」,
  // 可 bundle 内容一个字节都没变——报的是假警,报多了就没人看了(owner
  // 2026-08-15 实报「一直显示有一个黄色」)。改成比 web/ 的最后改动,
  // 只在客户端**真的**落后于已部署的前端时才亮。
  clientWebCommit = execSync("git log -1 --format=%h -- .", { cwd: __dirname }).toString().trim();
} catch { /* 非 git 环境(裸包部署):留空,splash 只显示服务端版本 */ }

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_CLIENT_COMMIT: clientCommit, NEXT_PUBLIC_CLIENT_WEB_COMMIT: clientWebCommit },
  // better-sqlite3 / ssh2 是原生模块，不能被 bundler 打包，交给 Node require
  serverExternalPackages: ["better-sqlite3", "ssh2"],
  // 允许经 Tailscale / 局域网 IP 访问 dev server 的 _next 资源（否则 Next 16 dev 对
  // 跨源 _next 请求告警，未来版本会直接拦）。手机走 Tailscale 测网页版时用得上。
  // 127.0.0.1：本机 Playwright 自动化测试——不在列表里 HMR websocket 握手会一直失败，
  // dev 页面周期性整页 reload（store 重挂、视图闪回空白），肉眼看着像灵异 bug。
  //
  // 自己的 tailnet IP / 局域网 IP / ts.net 主机名写进 .env.local 的 WEB_DEV_ORIGINS
  // （逗号分隔）。此前这里硬编码的是作者本人的三个地址，别人 clone 下来必须改源码
  // 才能用手机访问 dev server —— 那是最不该让用户碰的地方。
  allowedDevOrigins: [
    "127.0.0.1",
    ...(process.env.WEB_DEV_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ],
};

export default nextConfig;
