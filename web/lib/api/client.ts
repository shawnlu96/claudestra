/**
 * 前端唯一的 bridge 客户端（docs/design-hosted-frontend.md §8.3、§13.4）。此前 41 个文件里 91 处裸 `fetch("/api/…")` 打 BFF；
 * 现在浏览器直接打 bridge 的 `/api/v1/*`：基址 = 当前机器的 `/m/<fp>`（中继）或 ""（直托管），凭据是 HttpOnly cookie
 * （`credentials:"include"`），非 GET 自动带 `x-cstra-device: 1`（bridge 的 CSRF 门，见 bridge/api-auth.ts）。
 * 每个请求在**发出时**捕获目标机器：切机器时中止旧机器的在途请求 / SSE，迟到的响应也不许落到新机器上。
 * 401 = 凭据无效 / 过期 / 被撤销 → 该机器标「需重新配对」（lib/machines.ts），抛 DeviceInvalidError，调用方不用各自处理。
 */
import { appConfigSync, loadAppConfig, LOCAL_FP, machineBase } from "@/lib/app-config";
import { machines, type MachineRef } from "@/lib/machines";

export const DEVICE_HEADER = "x-cstra-device";
export const API_PREFIX = "/api/v1";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown> = {},
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
  /** bridge 明确说可重试（链路重连中）或 503：调用方可稍后再试，别当「真离线」报死 */
  get retryable(): boolean {
    return this.body.retryable === true || this.status === 503;
  }
}

export class DeviceInvalidError extends ApiError {
  constructor(readonly fp: string, code = "device_invalid") {
    super("device credential invalid — pair this browser again", 401, { code }, code);
    this.name = "DeviceInvalidError";
  }
}

/** 纯函数（tests/web-api-client.test.ts）：非 2xx 响应 → 该抛的错误。任何 401 都算凭据失效（没 cookie 也是「要配对」） */
export function apiErrorFrom(status: number, body: unknown, fp: string): ApiError {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const code = typeof b.code === "string" ? b.code : undefined;
  if (status === 401) return new DeviceInvalidError(fp, code ?? "device_invalid");
  const msg = typeof b.error === "string" && b.error ? b.error : `HTTP ${status}`;
  return new ApiError(msg, status, b, code);
}

/** 把外部 signal / 超时接到一个 controller 上（AbortSignal.any 在老 WebKit 上没有） */
export function linkSignals(ctrl: AbortController, signals: (AbortSignal | undefined)[]): void {
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      ctrl.abort(s.reason);
      return;
    }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
}

export interface ApiInit {
  method?: string;
  /** JSON 体（自动 stringify + Content-Type）；multipart 走 body */
  json?: unknown;
  body?: RequestInit["body"];
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** 缺省 GET 15s / 其它 60s；0 = 不限（SSE） */
  timeoutMs?: number;
  /** 页面隐藏 / 卸载时也要发出去的小请求（如协作视图的「看过了」） */
  keepalive?: boolean;
}

interface Target {
  fp: string;
  base: string;
  relay: boolean;
}

async function resolveTarget(machine?: MachineRef): Promise<Target> {
  const cfg = await loadAppConfig();
  if (cfg.mode === "direct") return { fp: cfg.fp || LOCAL_FP, base: "", relay: false };
  const fp = machine?.fp ?? machines.currentFp();
  if (!fp) throw new ApiError("no machine selected — pair one first", 0, {}, "no_machine");
  return { fp, base: machineBase(cfg, fp), relay: true };
}

/** 同步版基址（`<a download>`、SW 注册前等已知配置已加载的地方）；配置没到就按直托管 */
export function apiUrlSync(path: string, fp?: string): string {
  const cfg = appConfigSync();
  const target = fp ?? machines.currentFp() ?? LOCAL_FP;
  return `${cfg ? machineBase(cfg, target) : ""}${API_PREFIX}${path}`;
}

const inflight = new Map<string, Set<AbortController>>();

function track(fp: string, ctrl: AbortController): () => void {
  let set = inflight.get(fp);
  if (!set) inflight.set(fp, (set = new Set()));
  set.add(ctrl);
  return () => void set!.delete(ctrl);
}

/** 切机器 / 撤销时中止某机器的全部在途请求（含 SSE） */
export function abortMachineRequests(fp: string, reason = "machine switched"): void {
  for (const c of inflight.get(fp) ?? []) c.abort(new DOMException(reason, "AbortError"));
  inflight.delete(fp);
}
machines.onSwitch((prev) => {
  if (prev) abortMachineRequests(prev);
});

async function parseBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => ""); // 体读不出来（已中止 / 空体）按空对象，状态码仍然生效
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: text.slice(0, 300) }; // 非 JSON（反代错误页）：把正文当错误文案带给调用方
  }
}

async function send(path: string, init: ApiInit, machine: MachineRef | undefined, accept?: string): Promise<{ res: Response; target: Target }> {
  const target = await resolveTarget(machine);
  const method = (init.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (accept) headers.Accept = accept;
  if (method !== "GET" && method !== "HEAD") headers[DEVICE_HEADER] = "1";
  let body = init.body;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const ctrl = new AbortController();
  const timeoutMs = init.timeoutMs ?? (method === "GET" ? 15_000 : 60_000);
  linkSignals(ctrl, [init.signal, timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined]);
  const untrack = track(target.fp, ctrl);
  ctrl.signal.addEventListener("abort", untrack, { once: true });
  let res: Response;
  try {
    res = await fetch(`${target.base}${API_PREFIX}${path}`, { method, headers, body, credentials: "include", cache: "no-store", signal: ctrl.signal, keepalive: init.keepalive });
  } finally {
    // SSE（不限时）留在表里直到调用方 abort 或切机器把它中止——上面的 abort 监听负责出表
    if (timeoutMs > 0) untrack();
  }
  // 中继模式下响应回来时机器已经换了：这份数据属于旧机器，一律不交给调用方
  if (target.relay && !machine && machines.currentFp() !== target.fp) {
    ctrl.abort();
    throw new ApiError("machine switched while request was in flight", 0, {}, "machine_switched");
  }
  if (res.status === 401) {
    const b = await parseBody(res);
    machines.markRepair(target.fp);
    throw apiErrorFrom(401, b, target.fp);
  }
  return { res, target };
}

/** 原始响应（附件 blob、非 JSON）：401 已映射成 DeviceInvalidError，其余状态码由调用方看 */
export async function apiRaw(path: string, init: ApiInit = {}, machine?: MachineRef): Promise<Response> {
  return (await send(path, init, machine)).res;
}

/** JSON 请求：非 2xx 抛 ApiError（message 取 bridge 的 error，body 原样带上，如 409 的 runId） */
export async function api<T = Record<string, unknown>>(path: string, init: ApiInit = {}, machine?: MachineRef): Promise<T> {
  const { res, target } = await send(path, init, machine);
  const body = await parseBody(res);
  if (!res.ok) throw apiErrorFrom(res.status, body, target.fp);
  return body as T;
}

/** SSE-over-fetch：不限时、Accept text/event-stream；连接留在在途表里，切机器即中止（读端会收到 done/abort） */
export async function apiStream(path: string, init: ApiInit = {}, machine?: MachineRef): Promise<Response> {
  const { res, target } = await send(path, { ...init, timeoutMs: 0 }, machine, "text/event-stream");
  if (!res.ok || !res.body) throw apiErrorFrom(res.status, await parseBody(res), target.fp);
  return res;
}
