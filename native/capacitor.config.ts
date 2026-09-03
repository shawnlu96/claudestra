import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Claudestra iOS 壳。不打包前端:WKWebView 直接加载自托管的 web 客户端,登录态 /
 * 会话 / 历史全部沿用现有 BFF。壳只提供:原生图标启动图、状态栏与安全区、原生
 * 键盘处理、APNs 推送(WKWebView 没有 Service Worker,Web Push 在壳里不工作)。
 *
 * 服务器地址**不在这里**(owner 2026-09-04:壳要分发给别人,不能把个人地址编进包):
 * 首次启动加载本地 www/index.html 让用户填,存 UserDefaults,之后由
 * ios/App/App/ClaudestraViewController.swift 在运行时塞进 serverURL。设置页 /
 * web 设置里的「更换服务器」都走 ServerConfig 插件(ios/App/App/ServerConfig.swift)。
 */
const config: CapacitorConfig = {
  appId: "com.claudestra.app",
  appName: "Claudestra",
  webDir: "www",
  server: {
    // 远端连不上(Tailscale 没开 / 服务器离线)时显示本地错误页,而不是 WKWebView 的裸错误
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
    // 启动图:web 首屏就绪(agentsReady)时由 web 调 SplashScreen.hide() 收掉,最晚 6s
    // 兜底自动收——此前 500ms 就收,跨境链路上用户先看到一屏深色空白再等首屏
    SplashScreen: { launchAutoHide: true, launchShowDuration: 6000, launchFadeOutDuration: 200, backgroundColor: "#171819" },
    StatusBar: { style: "DARK", overlaysWebView: true },
    // 前台收到推送也展示横幅+声音(PWA 的 SW 在有焦点窗口时不弹;壳里统一按系统通知处理)
    PushNotifications: { presentationOptions: ["alert", "sound"] },
  },
};

export default config;
