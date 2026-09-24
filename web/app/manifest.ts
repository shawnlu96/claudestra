import type { MetadataRoute } from "next";

/**
 * PWA manifest（Next 原生约定 → 自动注入 <link rel="manifest">，输出 /manifest.webmanifest）。
 *
 * 偏离 claude-os（prin-3631bf）：claude-os 用动态 /api/manifest?page= + DynamicManifest 组件，
 * 是因为它多模块要「每页独立安装成各自 PWA」；claudestra 是单一 App，用静态约定即可，去掉那层复杂度。
 *
 * display:standalone → iOS 添加到主屏后全屏渲染（隐藏 Safari 地址栏/工具栏），配合 layout 的
 * viewport-fit=cover + safe-area 内缩（prin-fc2966）铺满刘海屏。scope 统一 '/' 防 iOS 返回异常。
 * 颜色取 dark 主题 base-100 rgb(23,24,25)=#171819。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Claudestra",
    short_name: "Claudestra",
    description: "远程操控本地 Claude Code 会话",
    start_url: "/chat",
    scope: "/",
    display: "standalone",
    // 邀请落地页的「在我的 Claudestra 中打开」（web+claudestra:），装成桌面 PWA 时也由本应用接
    protocol_handlers: [{ protocol: "web+claudestra", url: "/join?i=%s" }],
    orientation: "any",
    background_color: "#171819",
    theme_color: "#171819",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
