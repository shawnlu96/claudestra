import type { Metadata, Viewport } from "next";
import "./globals.css";
// 图片查看器 PhotoSwipe(相册级手势:捏合/双击/下拉关闭)——全局 CSS 只能在根 layout 引
import "photoswipe/dist/photoswipe.css";
import { I18nInit } from "@/lib/i18n";

export const metadata: Metadata = {
  title: "Claudestra",
  description: "Claudestra Web 客户端 — 远程操控本地 Claude Code 会话",
  applicationName: "Claudestra",
  // Next 自动注入 <link rel="manifest">（来自 app/manifest.ts），此处只补齐 iOS 主屏相关
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Claudestra",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    // iOS「添加到主屏幕」用 apple-touch-icon（全出血方图，iOS 自动圆角）
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  // Next 16 的 appleWebApp.capable 只发新标准 mobile-web-app-capable；显式补经典
  // apple-mobile-web-app-capable，最大化老版 iOS 触发 standalone 全屏的可靠性。
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // 装成 App 后禁止双指缩放/双击放大，贴近原生手感（standalone 下也更稳）
  maximumScale: 1,
  userScalable: false,
  // prin-fc2966：PWA 必须 viewport-fit=cover，否则 env(safe-area-inset-*) 恒为 0
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FFFFFF" },
    { media: "(prefers-color-scheme: dark)", color: "rgb(23,24,25)" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning:下面的内联脚本会在水合前给 html 加 data-theme
    <html lang="zh-CN" suppressHydrationWarning>
      {/* body 不设 bg：iOS 取画布色时 body 的 bg 会盖过 html，画布色跟随（globals.css
          canvas-list）必须落在 html 上。页面自身背景由应用壳根容器/面板各自绘制。 */}
      <body className="min-h-full text-base-content antialiased">
        {/* 明暗偏好 paint 前应用(lib/theme.ts 的 localStorage 键)——放 React 里
            要等水合,暗色用户会先白闪一帧 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("cstra_theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`,
          }}
        />
        {/* v2.17.2 启动看门狗(peer 报告:慢链路(DERP 中继)上主 bundle 加载失败/
            超时 → 黑屏/无限转圈,JS 完全没跑,连 client.log 上报都发不出,前端
            一声不吭。内联脚本不依赖 bundle,是唯一能在这种状态下发声的东西):
            25s 内没有任何页面宣告挂载(I18nInit 水合时置 __cstraMounted)就盖一层
            纯 HTML 提示 + 重载按钮,把「静默假死」变成可操作的失败。 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{setTimeout(function(){if(window.__cstraMounted)return;var d=document.createElement('div');d.style.cssText='position:fixed;inset:0;z-index:99999;background:rgba(20,21,23,.96);color:#e8e8ea;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center;font-family:system-ui';d.innerHTML='<div style=\\'font-size:15px;line-height:1.6\\'>\\u9875\\u9762\\u8d44\\u6e90\\u52a0\\u8f7d\\u5931\\u8d25\\u6216\\u7f51\\u7edc\\u8fc7\\u6162<br><span style=\\'font-size:12.5px;opacity:.65\\'>\\u4e3b\\u7a0b\\u5e8f 25 \\u79d2\\u5185\\u672a\\u80fd\\u542f\\u52a8</span></div><button style=\\'padding:9px 26px;border-radius:9px;background:#2b2d31;color:#fff;border:1px solid #4a4d52;font-size:14px\\' onclick=\\'location.reload()\\'>\\u91cd\\u65b0\\u52a0\\u8f7d</button>';document.body.appendChild(d)},25000)}catch(e){}})();`,
          }}
        />
        <I18nInit />
        {children}
      </body>
    </html>
  );
}
