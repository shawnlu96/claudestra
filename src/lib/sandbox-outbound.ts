/**
 * 沙箱进程的出站闸门（lib/sandbox.ts 的 enforceSandboxProcess 在确认沙箱配置安全后装一次）：只许连本机回环上的放行端口
 * （自己的 bridge，lab 模式再加 lab 端口），其余一律拒绝并打一行带 OUTBOUND_BLOCKED_MARK 的日志。
 *
 * 包住的是 globalThis.fetch / WebSocket，以及 node:http / node:https 的 request·get 与 node:http2 的 connect——
 * web-push 走 https.request、APNs 走 http2.connect，不包这三个，推送一旦被误开就能直达真推送服务。各功能在沙箱里本来就该
 * 自己关掉或只连 lab 的假端点，这里是兜底。只依赖 node: 模块（lib/sandbox.ts 引它，反向会成环）。
 */
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function portOf(u: URL): number {
  if (u.port) return Number(u.port);
  return u.protocol === "https:" || u.protocol === "wss:" ? 443 : 80;
}

/** 沙箱进程只许访问本机回环上的这些端口；其余一律拒绝 */
export function outboundAllowed(target: string | URL, allowedPorts: ReadonlySet<number>): boolean {
  let u: URL;
  try {
    u = typeof target === "string" ? new URL(target) : target;
  } catch {
    return false;
  }
  if (u.protocol === "file:" || u.protocol === "data:" || u.protocol === "blob:") return true;
  if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) return false;
  return LOOPBACK_HOSTS.has(u.hostname) && allowedPorts.has(portOf(u));
}

export const OUTBOUND_BLOCKED_MARK = "🧱 sandbox-outbound-blocked";

function requestUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return String((input as { url?: string })?.url ?? "");
}

type NodeOpts = { protocol?: string; hostname?: string; host?: string; port?: number | string; socketPath?: string; path?: string };

/**
 * node:http(s).request 的目标：第一个参数是 URL / 字符串就用它（第二个参数的 host / port 会覆盖，一并算上）；是选项对象就拼出来。
 * 走 unix socket 的（socketPath）返回 null——沙箱里没有合法用途，按拒绝处理。
 */
function nodeRequestTarget(args: unknown[], defaultProtocol: "http:" | "https:"): string | null {
  const [a, b] = args;
  const base = typeof a === "string" || a instanceof URL ? new URL(String(a)) : null;
  const o = ((base ? (b && typeof b === "object" ? b : {}) : a) ?? {}) as NodeOpts;
  if (o.socketPath) return null;
  const protocol = o.protocol || base?.protocol || defaultProtocol;
  const host = o.hostname || (o.host ? String(o.host).replace(/:\d+$/, "") : "") || base?.hostname || "localhost";
  const port = o.port ?? (base?.port || (o.host && /:\d+$/.test(String(o.host)) ? String(o.host).split(":").pop() : ""));
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${protocol}//${h}${port ? `:${port}` : ""}/`;
}

let guardInstalled = false;

export function installOutboundGuard(allowedPorts: ReadonlySet<number>): void {
  if (guardInstalled) return;
  guardInstalled = true;
  const blocked = (what: string) => {
    console.error(`${OUTBOUND_BLOCKED_MARK} ${what}`);
    return new Error(`沙箱模式拒绝出站请求：${what}`);
  };
  const origFetch = globalThis.fetch;
  const guarded = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = requestUrl(input);
    if (!outboundAllowed(url, allowedPorts)) return Promise.reject(blocked(url));
    return origFetch(input, init);
  }) as typeof fetch;
  globalThis.fetch = Object.assign(guarded, origFetch);
  const OrigWs = globalThis.WebSocket;
  globalThis.WebSocket = class extends OrigWs {
    constructor(url: string | URL, protocols?: string | string[]) {
      if (!outboundAllowed(String(url), allowedPorts)) throw blocked(String(url));
      super(url, protocols);
    }
  } as typeof WebSocket;
  // node 风格的客户端：拦在调用处同步抛出（web-push 包在 Promise 里，会变成一次失败的发送）
  const wrapNode = (mod: typeof http | typeof https, proto: "http:" | "https:") => {
    for (const fn of ["request", "get"] as const) {
      const orig = mod[fn] as (...a: unknown[]) => unknown;
      (mod as unknown as Record<string, unknown>)[fn] = (...args: unknown[]) => {
        const target = nodeRequestTarget(args, proto);
        if (!target || !outboundAllowed(target, allowedPorts)) throw blocked(target ?? `${proto} unix socket`);
        return orig.apply(mod, args);
      };
    }
  };
  wrapNode(http, "http:");
  wrapNode(https, "https:");
  const origConnect = http2.connect as (...a: unknown[]) => unknown;
  (http2 as unknown as Record<string, unknown>).connect = (authority: unknown, ...rest: unknown[]) => {
    const target = requestUrl(authority);
    if (!outboundAllowed(target, allowedPorts)) throw blocked(target);
    return origConnect.call(http2, authority, ...rest);
  };
}
