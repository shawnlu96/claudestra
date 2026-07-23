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
        <I18nInit />
        {children}
      </body>
    </html>
  );
}
