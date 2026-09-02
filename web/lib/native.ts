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
