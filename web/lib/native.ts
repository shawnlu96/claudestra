/**
 * v2.22+ 原生壳(native/ 的 Capacitor iOS App)识别。
 * 壳用 server.url 加载本站,Capacitor 会把 bridge 注入远端页面 → window.Capacitor 存在;
 * 插件经 window.Capacitor.Plugins.<Name> 调用,web 不需要打包 @capacitor/* 依赖。
 */
type CapPlugins = Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>;
interface CapGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: CapPlugins;
}

export function capacitor(): CapGlobal | null {
  if (typeof window === "undefined") return null;
  const c = (window as unknown as { Capacitor?: CapGlobal }).Capacitor;
  return c && typeof c === "object" ? c : null;
}

/** 运行在原生壳里(iOS App),而不是 Safari / PWA。 */
export function isNativeShell(): boolean {
  const c = capacitor();
  return !!c && (c.isNativePlatform?.() === true || (c.getPlatform?.() ?? "web") !== "web");
}

/** 取一个 Capacitor 插件(不存在返回 null)。 */
export function nativePlugin(name: string): Record<string, (...a: unknown[]) => Promise<unknown>> | null {
  const c = capacitor();
  const p = c?.Plugins?.[name];
  return p && typeof p === "object" ? p : null;
}

/**
 * v2.21.3+ 壳的服务器地址(ios/App/App/ServerConfig.swift):地址不编进包,存在本机。
 * clear() 后原生侧重建 WebView 回到首次设置页——调用方不会收到后续回调。
 */
export function nativeServerConfig(): { get: () => Promise<string>; clear: () => Promise<void> } | null {
  const p = nativePlugin("ServerConfig");
  if (!p) return null;
  return {
    get: async () => {
      const r = (await p.get()) as { url?: string } | undefined;
      return r?.url ?? "";
    },
    clear: async () => {
      await p.clear();
    },
  };
}

/** 壳的原生启动图:web 首屏就绪时收掉(capacitor.config 里最晚 6s 兜底自动收)。 */
export function hideNativeSplash(): void {
  const p = nativePlugin("SplashScreen");
  if (!p) return;
  void p.hide({ fadeOutDuration: 150 }).catch(() => {});
}
