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

/**
 * v2.21.4 键盘期把壳的底边抬到键盘上沿(只在 Keyboard 插件 resize=none 的设备上,
 * 即 layout.tsx 内联脚本判成 iPad 的壳)。resize=none 后 WebView 不再被原生缩小,
 * 停靠键盘靠 iOS 平移视觉视口揭示输入框,但 iPad 的分离/悬浮键盘是**覆盖**在页面上
 * 的,iOS 不平移——composer 被整个盖住(owner 2026-09-04 截图「直接看不到文字框了」)。
 * 插件在任何 resize 模式下都会发 keyboardDidShow/keyboardWillHide 窗口事件并带
 * keyboardHeight,拿它写 --cstra-kb-pad,壳根 fixed 容器的 bottom 跟着抬。用 DidShow
 * (动画结束)而不是 WillShow:聚焦到键盘 settle 之间改布局会把键盘打掉(死路③)。
 * iPhone 是 resize=native,原生已经缩了 WebView,这里不叠加。
 */
let kbPadInstalled = false;
/**
 * v2.22.x 壳状态栏文字颜色跟随 web 主题(owner 2026-09-07「打开应用之后上面看不到
 * 时间和电量」:capacitor.config 写死 StatusBar.style=DARK,即白字;浅色主题下白字
 * 贴在浅色顶栏上就「消失」)。Capacitor 的命名反直觉:Style.Dark = 深色背景用的浅色
 * 字,Style.Light = 浅色背景用的深色字。有效主题 = <html data-theme>(设置里钉住)
 * 或系统 prefers-color-scheme(auto)。设置切换 / 系统切换 / 回前台都重算一次。
 */
export function syncNativeStatusBar(): void {
  const p = nativePlugin("StatusBar");
  if (!p || typeof document === "undefined") return;
  const pinned = document.documentElement.getAttribute("data-theme");
  const dark = pinned ? pinned === "dark" : !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  void p.setStyle?.({ style: dark ? "DARK" : "LIGHT" }).catch(() => {});
}
let statusBarBound = false;
export function installNativeStatusBarSync(): void {
  if (statusBarBound || typeof window === "undefined" || !isNativeShell()) return;
  statusBarBound = true;
  syncNativeStatusBar();
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncNativeStatusBar);
  } catch { /* 老 WebKit 没有 addEventListener */ }
  try {
    new MutationObserver(syncNativeStatusBar).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  } catch { /* ignore */ }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncNativeStatusBar();
  });
}

export function installNativeKeyboardPadding(): void {
  if (kbPadInstalled || typeof window === "undefined" || !isNativeShell()) return;
  kbPadInstalled = true;
  const root = document.documentElement;
  const modeIsNone = () => String((window as unknown as { __cstraKbMode?: string }).__cstraKbMode ?? "").startsWith("none");
  const apply = (h: number) => {
    const px = Math.max(0, Math.round(h));
    root.style.setProperty("--cstra-kb-pad", `${px}px`);
    root.classList.toggle("kb-open", px > 0);
  };
  const heightOf = (e: Event) => {
    const ev = e as unknown as { keyboardHeight?: number; detail?: { keyboardHeight?: number } };
    return Number(ev.keyboardHeight ?? ev.detail?.keyboardHeight ?? 0) || 0;
  };
  window.addEventListener("keyboardDidShow", (e) => {
    if (modeIsNone()) apply(heightOf(e));
  });
  window.addEventListener("keyboardWillHide", () => apply(0));
}

/** 壳的原生启动图:web 首屏就绪时收掉(capacitor.config 里最晚 6s 兜底自动收)。 */
export function hideNativeSplash(): void {
  const p = nativePlugin("SplashScreen");
  if (!p) return;
  void p.hide({ fadeOutDuration: 150 }).catch(() => {});
}
