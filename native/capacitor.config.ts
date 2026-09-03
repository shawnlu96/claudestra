import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Claudestra iOS 壳。不打包前端:WKWebView 直接加载自托管的 web 客户端(经 Tailscale),
 * 登录态 / 会话 / 历史全部沿用现有 BFF。壳只提供:原生图标启动图、状态栏与安全区、
 * 原生键盘处理、APNs 推送(WKWebView 没有 Service Worker,Web Push 在壳里不工作)。
 * 改 server.url 即可指向别的部署。
 */
const config: CapacitorConfig = {
  appId: "com.claudestra.app",
  appName: "Claudestra",
  webDir: "www",
  server: {
    url: process.env.CLAUDESTRA_URL || "https://mac-mini-jp.tailfdc471.ts.net",
    cleartext: false,
    // 远端连不上(Tailscale 没开 / mini 离线)时显示本地错误页,而不是 WKWebView 的裸错误
    errorPath: "error.html",
  },
  ios: {
    contentInset: "never",
    backgroundColor: "#171819",
    preferredContentMode: "mobile",
    allowsLinkPreview: false,
    scrollEnabled: true,
  },
  plugins: {
    Keyboard: { resize: "native", resizeOnFullScreen: true },
    SplashScreen: { launchAutoHide: true, launchFadeOutDuration: 200, backgroundColor: "#171819" },
    StatusBar: { style: "DARK", overlaysWebView: true },
    // 前台收到推送也展示横幅+声音(PWA 的 SW 在有焦点窗口时不弹;壳里统一按系统通知处理)
    PushNotifications: { presentationOptions: ["alert", "sound"] },
  },
};

export default config;
