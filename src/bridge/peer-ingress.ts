/**
 * peer API 入口：bridge 在回环上另开一个端口（默认 bridge 端口 + 1），保留本机反代的网页兼容路径，
 * 给 HTTPS 反代（Caddy 的 `handle /api/v1/*`、tailscale serve 的 `--set-path /api/v1`）转发用。
 *
 * 为什么不让反代直接打主端口：经反代进来的请求源地址是 127.0.0.1，主端口对回环一律放行
 * （控制面路由、ws 升级都在那儿），`/api/v1/../hook` 这种路径一规整就是回环特权——等于把
 * 控制面和 ws（宿主 RCE）经 443 交给整个 tailnet。这里从结构上断掉：
 *   - 只调 /api/v1 的处理函数（注入的 handleApi），控制面、ws、远程终端根本不在这个入口上；
 *   - Bearer（含 SSE 查询 token）必须属于 peer；非 peer 的 Bearer 在所有 socket 来源下都拒；
 *   - 本机反代转来的（网页经 HTTPS 入口）还认设备 cookie；对外直连与中继 peer 帧只认 peer token，
 *     不带凭据只剩兑换邀请和邀请页（见 ingressRequest）。
 * 有了它，peer 走 HTTPS 443 就行，3847 不必对外开放、也不用给每个 peer 加防火墙白名单。
 * 没有 HTTPS 的机器，它自己对外当直连入口（ingressHost）——同样只有 peer 能用，主端口照旧只听本机。
 */
import { findByBearer, readPrincipals } from "../lib/principals.js";
import { configuredPeerIngressPort } from "../lib/bridge-url.js";
import { repoEnvVar } from "../lib/env-file.js";
import { relayMark, takeRelayFrom, TUNNEL_MARK_HEADER } from "./relay-inbound.js";
import { PEER_ENTRANCE_ONLY, setRequestContext } from "./request-context.js";
import { drainingFetch } from "./unread-body.js";
import { isLoopbackAddress } from "../lib/same-host.js";
import { DEVICE_HEADER } from "../lib/devices.js";
import { HTTP_IDLE_TIMEOUT_S } from "../lib/esc-guard.js";
import { MAX_HTTP_BODY, MAX_PEER_BODY, readBoundedRequestBody, RequestBodyError } from "../lib/request-body.js";

export { configuredPeerIngressPort };

/** 反代剥不剥挂载前缀都认：Caddy 的 handle 保留 /api/v1/…；tailscale serve 挂在路径下可能剥成 /… */
export function ingressApiPath(pathname: string): string {
  if (pathname === "/api/v1" || pathname.startsWith("/api/v1/")) return pathname;
  return `/api/v1${pathname === "/" ? "" : pathname}`;
}

/** 请求里带的凭据：Bearer，或（与 authApi 同口径）GET /api/v1/events 的 ?token= */
export function ingressSecret(req: { method: string; headers: { get(k: string): string | null } }, url: URL): string {
  const m = (req.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (m?.[1]?.trim()) return m[1].trim();
  return req.method === "GET" && url.pathname === "/api/v1/events" ? url.searchParams.get("token") || "" : "";
}

/** Bearer / SSE token 必须属于 peer；设备 cookie 的反代兼容例外在 ingressRequest 单独判定 */
export function ingressVerdict(secret: string, principal: { peer?: string } | null): "ok" | "not-peer" {
  if (!secret) return "ok";
  return principal?.peer ? "ok" : "not-peer";
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Host = "127.0.0.1" | "0.0.0.0";
type ApiHandler = (req: Request, url: URL) => Promise<Response>;

/**
 * 纯判定（tests/peer-ingress.test.ts）：入口开在哪。默认只给本机反代用；.env 标了直连
 * （PEER_INGRESS_PUBLIC=1，生成邀请时没有 HTTPS 入口才会标）且确实有 peer（或刚被要求 hold）才对外。
 * 对外也只多出 peer token + 兑换邀请 + 邀请页这一小块——主端口的控制面、ws、全权 token、设备凭据都不在这个入口上。
 */
export function ingressHost(publicFlag: boolean, hasPeers: boolean, holdUntil: number, now: number): Host {
  return publicFlag && (hasPeers || now < holdUntil) ? "0.0.0.0" : "127.0.0.1";
}

const HOLD_MS = 10 * 60_000;
let handler: ApiHandler | null = null;
let cur: { srv: ReturnType<typeof servePeerIngress>; port: number; host: Host } | null = null;
let holdUntil = 0;

/** 有没有在用的 peer token（兑换前的邀请也签了 peer token，一并算）；读失败按「有」算，宁可保持现状 */
async function hasPeerTokens(): Promise<boolean> {
  try {
    return (await readPrincipals()).principals.some((p) => p.peer && !p.disabled);
  } catch {
    return true;
  }
}

/**
 * 按 .env（每次现读：manager 生成邀请时才写进去）+ 当前 peer 情况，把入口开到该开的地方；已是目标状态就不动。
 * 端口没配就不开；起不来（端口被占等）只记日志：附加能力，不能拖垮 bridge。
 */
export async function syncPeerIngress(hold = false): Promise<{ port: number | null; host: Host | null }> {
  if (hold) holdUntil = Date.now() + HOLD_MS;
  const port = configuredPeerIngressPort({ PEER_INGRESS_PORT: repoEnvVar("PEER_INGRESS_PORT") });
  const host = port ? ingressHost(repoEnvVar("PEER_INGRESS_PUBLIC") === "1", await hasPeerTokens(), holdUntil, Date.now()) : null;
  if (cur && cur.port === port && cur.host === host) return { port, host };
  cur?.srv.stop(true);
  cur = null;
  if (!port || !host || !handler) return { port, host: null };
  try {
    cur = { srv: servePeerIngress({ port, host, handleApi: handler }), port, host };
    const how = host === "0.0.0.0" ? "对外直连，外来的只收 peer token" : "只听本机，供 HTTPS 反代转发";
    console.log(`🤝 peer 入口: http://${host}:${port}（${how}）`);
    return { port, host };
  } catch (e) {
    console.error(`⚠️ peer 入口起不来（${host}:${port}）: ${(e as Error).message}——peer 只能走 bridge 主端口`);
    return { port, host: null };
  }
}

/** bridge 启动时调一次；之后每分钟按 peer 情况收放（peer 全删了，直连入口就退回本机） */
export function initPeerIngress(handleApi: ApiHandler): void {
  handler = handleApi;
  void syncPeerIngress();
  setInterval(() => void syncPeerIngress(), 60_000);
}

/** POST /peer-ingress/sync（控制面，只有回环能调）：manager 生成直连邀请前让入口立刻对外 */
export async function peerIngressSyncRoute(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { hold?: boolean }; // 空 body = 只按现状同步
  return json(200, { ok: true, ...(await syncPeerIngress(body.hold === true)) });
}

/** 不带凭据时对外只开这两个口：兑换邀请（凭一次性 join 口令）和邀请落地页 */
function ingressPublicRoute(method: string, pathname: string): boolean {
  return (method === "POST" && pathname === "/api/v1/peers/redeem") || (method === "GET" && pathname === "/api/v1/invite");
}

/**
 * 入口收到的一个请求（单测直接调，不开端口），按来源分两种待遇（docs/relay/protocol.md §4.1 的四类来源里，入口只见这两种）：
 *   - 回环 socket、没有中继标记、也没有隧道标记头 = 本机反代（tailscale serve 把 /api/v1 挂到这里，网页经 HTTPS 入口也走它）：
 *     与主端口经反代同待遇（来源 lan，设备 cookie 照认）。前提是中继够不到这个端口——隧道与 peer 帧的 path
 *     都过了同源断言（relay-inbound.ts localUrl），选端口时也避开网页端口；这些松了，这一类就不再成立。
 *   - 中继转来的 peer 帧（进程内标记核过）与非回环 socket（PEER_INGRESS_PUBLIC=1 直接对外）：来源 peer-ingress，
 *     删掉 cookie 与设备头；不带凭据只放兑换与邀请页，其余 403。设备端点与设备凭据在这个来源下一律拒。
 */
export async function ingressRequest(req: Request, handleApi: ApiHandler, addr: string | null = null): Promise<Response> {
  if (req.headers.get("upgrade")) return json(400, { ok: false, error: "no websocket on the peer entrance" });
  const raw = new URL(req.url);
  const url = new URL(ingressApiPath(raw.pathname) + raw.search, raw.origin);
  const secret = ingressSecret(req, url);
  const principal = secret ? findByBearer(await readPrincipals(), secret) : null;
  if (ingressVerdict(secret, principal) === "not-peer") {
    return json(403, PEER_ENTRANCE_ONLY);
  }
  // 来源指纹只认经中继进来的（relay-inbound.ts 盖了进程内标记），放进请求上下文；原始头一律剥掉
  const headers = new Headers(req.headers);
  const relayFrom = takeRelayFrom(headers, relayMark());
  // 带隧道标记头的（不论值）不算本机反代：隧道只该打网页端口，打到这里说明端口配撞了
  const tunnelled = headers.has(TUNNEL_MARK_HEADER);
  headers.delete(TUNNEL_MARK_HEADER);
  const localProxy = !relayFrom && !tunnelled && isLoopbackAddress(addr);
  if (!localProxy) {
    headers.delete("cookie");
    headers.delete(DEVICE_HEADER);
    if (!secret && !ingressPublicRoute(req.method, url.pathname)) return json(403, PEER_ENTRANCE_ONLY);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  // 配对与旧会话迁移要先于设备鉴权；其余无凭据 POST 不替路由预读正文，避免反代兼容成为慢上传入口。
  const publicDevice = localProxy && ["/api/v1/devices/pair", "/api/v1/devices/legacy-session"].includes(url.pathname);
  if (hasBody && !secret && !headers.has("cookie") && !ingressPublicRoute(req.method, url.pathname) && !publicDevice) return json(403, PEER_ENTRANCE_ONLY);
  const browserUpload = localProxy && !secret && headers.has("cookie") && !publicDevice && !ingressPublicRoute(req.method, url.pathname);
  let body: Uint8Array | undefined;
  try {
    if (hasBody) body = await readBoundedRequestBody(req, browserUpload ? MAX_HTTP_BODY : MAX_PEER_BODY);
  } catch (e) {
    if (!(e instanceof RequestBodyError)) throw e;
    const res = json(e.status, { ok: false, error: e.code, code: e.code });
    res.headers.set("connection", "close");
    return res;
  }
  const apiReq = new Request(url.toString(), { method: req.method, headers, body });
  setRequestContext(apiReq, localProxy
    ? { source: "lan", clientIp: addr, https: req.headers.get("x-forwarded-proto") === "https" }
    : { source: "peer-ingress", clientIp: relayFrom ? null : addr, https: false, ...(relayFrom ? { relayFrom } : {}) });
  return handleApi(apiReq, url);
}

export function servePeerIngress(opts: { port: number; host: Host; handleApi: ApiHandler }) {
  return Bun.serve({
    maxRequestBodySize: MAX_HTTP_BODY,
    port: opts.port,
    hostname: opts.host,
    idleTimeout: HTTP_IDLE_TIMEOUT_S, // peer 的打断请求要等 Esc 窗口锁，Bun 默认 10 秒会先切断（lib/esc-guard.ts）
    // 提前拒绝的请求没读正文：读掉再回，不然同一条连接上的下一个 peer 请求得 400（bridge/unread-body.ts）
    fetch: drainingFetch((req: Request, server: Bun.Server<undefined>) => ingressRequest(req, opts.handleApi, server.requestIP(req)?.address ?? null)),
  });
}
