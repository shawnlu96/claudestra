import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
