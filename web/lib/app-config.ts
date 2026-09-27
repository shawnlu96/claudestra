/**
 * 入口模式（docs/design-hosted-frontend.md §8.2、§13.4）：托管方提供 `/app-config.json`，前端不猜「origin 像不像中继」。
 *   relay  = 中继托管，API 基址是当前机器的 `/m/<fp>`；
 *   direct = bridge 直托管 / 本机回环，基址是 ""，只有这一台机器。
 * 只拉一次（缓存 promise）；拉不到时按 direct 兜底，否则 `next dev` 对着本机 bridge 就没法用。
 */
export interface RelayConfig {
  mode: "relay";
  relayBase: string;
  version: string;
  commit?: string;
  /** 中继托管的 bundle 烤入的 CLIENT_WEB_COMMIT（有它才能精确判「前端是否滞后」，见 lib/version-check.ts） */
  webCommit?: string;
  vapidPublicKey?: string;
}
export interface DirectConfig {
  mode: "direct";
  fp: string;
  machineName: string;
  /** 这台机器连着的中继（有才报）：认出已废弃的子域名入口 <slug>.<relayBase> 用 */
  relayBase?: string;
  version: string;
  commit?: string;
  webCommit?: string;
  vapidPublicKey?: string;
}
export type AppConfig = RelayConfig | DirectConfig;

/** direct 模式没给 fp（老 bridge / 本地 dev）时机器记录用的键 */
export const LOCAL_FP = "local";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** 纯函数（tests/web-api-client.test.ts）：JSON → AppConfig；形状不对就用兜底 */
export function parseAppConfig(raw: unknown, fallback: DirectConfig): AppConfig {
  if (!raw || typeof raw !== "object") return fallback;
  const o = raw as Record<string, unknown>;
  const common = {
    version: str(o.version) ?? "",
    ...(str(o.commit) ? { commit: str(o.commit) } : {}),
    ...(str(o.webCommit) ? { webCommit: str(o.webCommit) } : {}),
    ...(str(o.vapidPublicKey) ? { vapidPublicKey: str(o.vapidPublicKey) } : {}),
  };
  if (o.mode === "relay" && str(o.relayBase)) return { mode: "relay", relayBase: str(o.relayBase)!, ...common };
  if (o.mode === "direct") {
    const relayBase = str(o.relayBase);
    return { mode: "direct", fp: str(o.fp) ?? fallback.fp, machineName: str(o.machineName) ?? fallback.machineName, ...(relayBase ? { relayBase } : {}), ...common };
  }
  return fallback;
}

/** 已废弃的子域名入口 <slug>.<中继>（中继主机本身不算；web/features/machines/legacy-subdomain.ts 据此搬家） */
export function isLegacySubdomain(hostname: string, relayBase: string | undefined): boolean {
  if (!relayBase) return false;
  const h = hostname.toLowerCase();
  const base = relayBase.toLowerCase();
  return h !== base && h.endsWith(`.${base}`);
}

/** 请求的基址：中继模式按机器加 `/m/<fp>`；直托管就是同源根 */
export function machineBase(cfg: AppConfig, fp: string): string {
  return cfg.mode === "relay" ? `/m/${fp}` : "";
}

// CONTRACT: /app-config.json 缺失或不是 JSON（本地 next dev 直连 bridge、老 bridge 没这个文件）→ 按 direct 单机模式，fp 用 LOCAL_FP。
export function directFallback(): DirectConfig {
  // 根 tsconfig 无 dom lib（tests/ 直接编译本文件）：location 从 globalThis 取
  const host = (globalThis as { location?: { hostname?: string } }).location?.hostname ?? "";
  return { mode: "direct", fp: LOCAL_FP, machineName: host || "local", version: "" };
}

let pending: Promise<AppConfig> | null = null;
let loaded: AppConfig | null = null;

/**
 * 默认只拉一次；`refresh` 重新拉一次并更新缓存（版本检查用：中继模式下「前端有没有新版」看的是 app-config 的 webCommit，
 * 常驻的 PWA 只在启动时拉一次就永远发现不了新版）。刷新拉不到（离线）时保留已有配置，绝不让一次网络抖动把模式改成 direct。
 */
export function loadAppConfig(opts: { refresh?: boolean } = {}): Promise<AppConfig> {
  if (loaded && !opts.refresh) return Promise.resolve(loaded);
  pending ??= fetch("/app-config.json", { cache: "no-store", credentials: "omit" })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null) // 网络错误与 404 同样按兜底处理；下面首次加载对 null 返回 fallback、刷新时保留旧值
    .then((j) => {
      const prev = loaded;
      loaded = j || !prev ? parseAppConfig(j, directFallback()) : prev;
      pending = null;
      return loaded;
    });
  return pending;
}

/** 已加载的配置（同步路径用：渲染期、SW 注册前等）；还没拉到就是 null */
export function appConfigSync(): AppConfig | null {
  return loaded;
}

/** 单测 / 故事重放用：把配置钉住，不走 fetch */
export function setAppConfigForTest(cfg: AppConfig | null): void {
  loaded = cfg;
  pending = null;
}
