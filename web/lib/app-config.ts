/**
 * 入口模式（docs/design-hosted-frontend.md §8.2、§13.4）：托管方提供 `/app-config.json`，前端不猜「origin 像不像中继」。
 *   relay  = 中继托管，API 基址是当前机器的 `/m/<fp>`；
 *   direct = bridge 直托管 / 本机回环，基址是 ""，只有这一台机器。
 * 只拉一次（缓存 promise）；文件不在（404）或不是 JSON 时按 direct 兜底，否则 `next dev` 对着本机 bridge 就没法用；
 * 网络错误 / 5xx 不算「不在」，重试后仍不行就报错（decideConfigLoad）。
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

/** 首次加载拉 /app-config.json 的结果种类（纯判定的输入） */
export type ConfigFetchResult =
  | { kind: "json"; body: unknown }
  | { kind: "status"; status: number }
  | { kind: "not-json" }
  | { kind: "network-error" };

export type ConfigLoadDecision = { action: "relay" | "direct"; cfg: AppConfig } | { action: "retry"; delayMs: number } | { action: "fail" };

/** 网络错误 / 5xx 的重试间隔：1s、2s、4s，三次都不行就 fail */
export const CONFIG_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

/** 暂时性失败（网络错误、5xx、408、429）：重试，不当成「没有这个文件」 */
function transient(res: ConfigFetchResult): boolean {
  if (res.kind === "network-error") return true;
  return res.kind === "status" && (res.status >= 500 || res.status === 408 || res.status === 429);
}

/**
 * 纯函数（tests/web-app-config.test.ts）：首次加载第 attempt 次（从 0 起）的结果 → 怎么办。
 * 网络错误不等于直托管：只有文件确实不在（404 等）或不是 JSON 才按 CONTRACT 走 direct；暂时性失败先重试，用完就 fail。
 */
export function decideConfigLoad(res: ConfigFetchResult, attempt: number): ConfigLoadDecision {
  if (transient(res)) {
    const delayMs = CONFIG_RETRY_DELAYS_MS[attempt];
    return delayMs === undefined ? { action: "fail" } : { action: "retry", delayMs };
  }
  const cfg = parseAppConfig(res.kind === "json" ? res.body : null, directFallback());
  return { action: cfg.mode, cfg };
}

/** 首次加载重试用完仍连不上：MachineGate 认它显示「连不上，点重试」，不写任何机器记录 */
export class AppConfigUnreachableError extends Error {
  readonly code = "app_config_unreachable";
  constructor() {
    super("cannot reach /app-config.json");
    this.name = "AppConfigUnreachableError";
  }
}

async function fetchConfig(): Promise<ConfigFetchResult> {
  let r: Response;
  try {
    r = await fetch("/app-config.json", { cache: "no-store", credentials: "omit" });
  } catch {
    return { kind: "network-error" };
  }
  if (!r.ok) return { kind: "status", status: r.status };
  try {
    return { kind: "json", body: await r.json() };
  } catch {
    return { kind: "not-json" };
  }
}

let sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function firstLoad(): Promise<AppConfig> {
  for (let attempt = 0; ; attempt++) {
    const d = decideConfigLoad(await fetchConfig(), attempt);
    if (d.action === "fail") throw new AppConfigUnreachableError();
    if (d.action !== "retry") return d.cfg;
    await sleep(d.delayMs);
  }
}

/** 刷新：拉到合法 JSON 才换，其余（离线、404、坏 JSON）一律保留旧配置 */
async function refreshLoad(prev: AppConfig): Promise<AppConfig> {
  const res = await fetchConfig();
  return res.kind === "json" ? parseAppConfig(res.body, directFallback()) : prev;
}

let pending: Promise<AppConfig> | null = null;
let loaded: AppConfig | null = null;

/**
 * 默认只拉一次；`refresh` 重新拉一次并更新缓存（版本检查用：中继模式下「前端有没有新版」看的是 app-config 的 webCommit，
 * 常驻的 PWA 只在启动时拉一次就永远发现不了新版）。刷新拉不到（离线）时保留已有配置，绝不让一次网络抖动把模式改成 direct。
 * 首次加载连不上时按 decideConfigLoad 重试，仍不行就 reject AppConfigUnreachableError（不缓存失败，下次调用重新拉）。
 */
export function loadAppConfig(opts: { refresh?: boolean } = {}): Promise<AppConfig> {
  if (loaded && !opts.refresh) return Promise.resolve(loaded);
  const prev = loaded;
  pending ??= (prev ? refreshLoad(prev) : firstLoad())
    .then((cfg) => (loaded = cfg))
    .finally(() => {
      pending = null;
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

/** 单测用：替换首次加载重试的等待（不真等 1s / 2s / 4s） */
export function setAppConfigSleepForTest(fn: (ms: number) => Promise<void>): void {
  sleep = fn;
}
