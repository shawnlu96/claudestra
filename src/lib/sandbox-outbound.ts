/**
 * 沙箱进程的出站闸门（lib/sandbox.ts 的 enforceSandboxProcess 在确认沙箱配置安全后装一次）：只许连本机回环上的放行端口
 * （自己的 bridge，lab 模式再加 lab 端口），其余一律拒绝并打一行带 OUTBOUND_BLOCKED_MARK 的日志。
 *
 * 包住的是进程内能发起连接的入口：globalThis.fetch / WebSocket、node:http(s) 的 request·get、node:http2 的 connect、
 * net.Socket 的 connect（net / tls / http2 在 Bun 里最后都走它）与 Bun.connect。子进程（curl、git……）包不住，边界见
 * docs/architecture/sandbox.md。只依赖 node: 模块（lib/sandbox.ts 引它，反向会成环）。
 */
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";

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

const PROXY_KEYS = {
  plain: ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"],
  secure: ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"],
};
/** 每个代理环境变量见过的全部值：Bun 读到代理变量后，进程里再 delete 它并不生效，所以按「见过的都算」判 */
const envSeen = new Map<string, string[]>();

function envValues(key: string): string[] {
  const list = envSeen.get(key) ?? [];
  const v = process.env[key];
  if (v !== undefined && !list.includes(v)) envSeen.set(key, (list.push(v), list));
  return list;
}

/** NO_PROXY 只认逐字的主机名或「主机:端口」（与 Bun 实测一致；后缀匹配之类当作不绕过，最多多拒） */
function noProxyBypasses(u: URL): boolean {
  const hits = (v: string) => v.split(",").map((s) => s.trim()).some((e) => e === "*" || e === u.hostname || e === `${u.hostname}:${portOf(u)}`);
  return ["NO_PROXY", "no_proxy"].some((k) => {
    const vals = envValues(k);
    return vals.length > 0 && vals.every(hits);
  });
}

/** 代理环境会把这个请求交给闸外的代理 → 返回说明；不走代理或代理本身在放行名单里 → null */
function envProxyProblem(target: string, allowedPorts: ReadonlySet<number>): string | null {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return null; // 不是 URL：outboundAllowed 已经拒了
  }
  const keys = u.protocol === "https:" || u.protocol === "wss:" ? PROXY_KEYS.secure : PROXY_KEYS.plain;
  const proxies = keys.flatMap(envValues).filter((v) => v.trim());
  if (!proxies.length || noProxyBypasses(u)) return null;
  const bad = proxies.find((p) => !outboundAllowed(p, allowedPorts));
  return bad ? `${target}（代理环境会经 ${bad} 转发）` : null;
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
  return hostPortUrl(protocol, host, port);
}

function hostPortUrl(protocol: string, host: string, port: unknown): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${protocol}//${h}${port !== undefined && port !== "" ? `:${port}` : ""}/`;
}

/**
 * net.Socket#connect 的目标（Bun 里 net.connect / tls.connect / http2 都把参数规整成 [[选项, 回调]] 再调它）：
 * unix socket（path）返回 null 按拒绝处理；TCP 拼成 http://host:port/ 交给 outboundAllowed 判。
 */
function socketTarget(args: unknown[]): string | null {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    return hostPortUrl("http:", typeof args[1] === "string" ? args[1] : "localhost", first);
  }
  if (typeof first === "string") return null;
  const o = (first ?? {}) as { path?: string; host?: string; port?: unknown };
  return o.path ? null : hostPortUrl("http:", o.host || "localhost", o.port);
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

let guardInstalled = false;

export function installOutboundGuard(allowedPorts: ReadonlySet<number>): void {
  if (guardInstalled) return;
  guardInstalled = true;
  const blocked = (what: string) => {
    console.error(`${OUTBOUND_BLOCKED_MARK} ${what}`);
    return new Error(`沙箱模式拒绝出站请求：${what}`);
  };
  /** 目标不在名单、或代理环境会把它交给闸外代理 → 拦截用的 Error；放行 → null */
  const check = (target: string | null, what = target ?? "unix socket"): Error | null => {
    if (!target || !outboundAllowed(target, allowedPorts)) return blocked(what);
    const p = envProxyProblem(target, allowedPorts);
    return p ? blocked(p) : null;
  };
  guardFetch(check, blocked);
  guardWebSocket(check, blocked);
  guardNodeClients(check);
  guardSockets(check);
}

type Check = (target: string | null, what?: string) => Error | null;

function guardFetch(check: Check, blocked: (what: string) => Error): void {
  const origFetch = globalThis.fetch;
  const guarded = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const extra = (init ?? {}) as { proxy?: unknown; unix?: unknown };
    if (extra.proxy) throw blocked(`${requestUrl(input)}（显式 proxy ${String(extra.proxy)}）`);
    if (extra.unix) throw blocked(`${requestUrl(input)}（unix socket ${String(extra.unix)}）`);
    const url = requestUrl(input);
    const err = check(url);
    if (err) throw err;
    const mode = init?.redirect ?? (input instanceof Request ? input.redirect : "follow");
    if (mode !== "follow") return origFetch(input, init); // manual / error：Bun 不会自己跟随，闸只需验这一跳
    return followRedirects(origFetch, check, input, init);
  }) as typeof fetch;
  globalThis.fetch = Object.assign(guarded, origFetch);
}

/**
 * 跟随重定向由闸自己做：每一跳用 redirect:"manual" 发，Location 先过闸再发下一跳（Bun 自己跟随时不会再经过包装）。
 * 正文先读进内存，307 / 308 原样重发；303、以及 301 / 302 的 POST 按规范改 GET 丢正文；换了源就去掉 Authorization / Cookie。
 */
async function followRedirects(
  origFetch: typeof fetch, check: Check, input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const first = new Request(input as string, init);
  let body: ArrayBuffer | undefined = first.body ? await first.arrayBuffer() : undefined;
  let [url, method, headers] = [first.url, first.method, new Headers(first.headers)];
  const signal = init?.signal ?? first.signal;
  for (let hop = 0; ; hop++) {
    const res = await origFetch(url, { ...init, method, headers, body, signal, redirect: "manual" });
    const loc = res.headers.get("location");
    if (!REDIRECTS.has(res.status) || !loc) return res;
    await res.body?.cancel();
    if (hop >= MAX_REDIRECTS) throw new Error(`沙箱模式：重定向超过 ${MAX_REDIRECTS} 跳（${url}）`);
    const next = new URL(loc, url).href;
    const err = check(next, `${next}（${url} 重定向过去的）`);
    if (err) throw err;
    if (res.status === 303 || (res.status !== 307 && res.status !== 308 && method === "POST")) {
      [method, body] = [method === "HEAD" ? "HEAD" : "GET", undefined];
      for (const h of ["content-type", "content-length"]) headers.delete(h);
    }
    if (new URL(next).origin !== new URL(url).origin) for (const h of ["authorization", "cookie"]) headers.delete(h);
    url = next;
  }
}

function guardWebSocket(check: Check, blocked: (what: string) => Error): void {
  const OrigWs = globalThis.WebSocket;
  globalThis.WebSocket = class extends OrigWs {
    constructor(url: string | URL, protocols?: string | string[] | { proxy?: unknown }) {
      if (protocols && typeof protocols === "object" && !Array.isArray(protocols) && protocols.proxy) {
        throw blocked(`${String(url)}（显式 proxy ${String(protocols.proxy)}）`);
      }
      const err = check(String(url));
      if (err) throw err;
      super(url, protocols as string | string[]);
    }
  } as typeof WebSocket;
}

/** node 风格的客户端：拦在调用处同步抛出（web-push 包在 Promise 里，会变成一次失败的发送） */
function guardNodeClients(check: Check): void {
  const wrapNode = (mod: typeof http | typeof https, proto: "http:" | "https:") => {
    for (const fn of ["request", "get"] as const) {
      const orig = mod[fn] as (...a: unknown[]) => unknown;
      (mod as unknown as Record<string, unknown>)[fn] = (...args: unknown[]) => {
        const err = check(nodeRequestTarget(args, proto));
        if (err) throw err;
        return orig.apply(mod, args);
      };
    }
  };
  wrapNode(http, "http:");
  wrapNode(https, "https:");
  const origConnect = http2.connect as (...a: unknown[]) => unknown;
  (http2 as unknown as Record<string, unknown>).connect = (authority: unknown, ...rest: unknown[]) => {
    const err = check(requestUrl(authority));
    if (err) throw err;
    return origConnect.call(http2, authority, ...rest);
  };
}

/**
 * 底层 socket：net.Socket#connect 拦下时像「连不上」一样异步以 error 销毁（调用方按连接失败处理，不会因同步抛错崩掉），
 * Bun.connect 返回被拒的 Promise。放行名单同上；unix socket 一律拒。
 */
function guardSockets(check: Check): void {
  const proto = net.Socket.prototype as unknown as { connect: (...a: unknown[]) => unknown; destroy: (e?: Error) => unknown };
  const origConnect = proto.connect;
  proto.connect = function (this: typeof proto, ...args: unknown[]) {
    const err = check(socketTarget(args));
    if (!err) return origConnect.apply(this, args);
    process.nextTick(() => this.destroy(err));
    return this;
  };
  const bun = globalThis.Bun as unknown as { connect: (o: { hostname?: string; port?: number; unix?: string }) => Promise<unknown> };
  const origBunConnect = bun.connect.bind(bun);
  bun.connect = (o) => {
    const err = check(o?.unix ? null : hostPortUrl("http:", o?.hostname || "localhost", o?.port));
    return err ? Promise.reject(err) : origBunConnect(o);
  };
}
