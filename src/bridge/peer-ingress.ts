/**
 * peer 专用入口：bridge 在回环上另开一个端口（默认 bridge 端口 + 1），只服务 peer，
 * 给 HTTPS 反代（Caddy 的 `handle /api/v1/*`、tailscale serve 的 `--set-path /api/v1`）转发用。
 *
 * 为什么不让反代直接打主端口：经反代进来的请求源地址是 127.0.0.1，主端口对回环一律放行
 * （控制面路由、ws 升级都在那儿），`/api/v1/../hook` 这种路径一规整就是回环特权——等于把
 * 控制面和 ws（宿主 RCE）经 443 交给整个 tailnet。这里从结构上断掉：
 *   - 只调 /api/v1 的处理函数（注入的 handleApi），控制面、ws、远程终端根本不在这个入口上；
 *   - 带了凭据就必须是 peer 签的 token（principal.peer），网页用的全权 token 从这里进不来；
 *     没带凭据只剩兑换邀请（凭一次性 join 口令）和 API 自己回 401。
 * 有了它，peer 走 HTTPS 443 就行，3847 不必对外开放、也不用给每个 peer 加防火墙白名单。
 * 没有 HTTPS 的机器，它自己对外当直连入口（ingressHost）——同样只有 peer 能用，主端口照旧只听本机。
 */
import { findByBearer, readPrincipals } from "../lib/principals.js";
import { configuredPeerIngressPort } from "../lib/bridge-url.js";
import { repoEnvVar } from "../lib/env-file.js";

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

/** 纯判定（tests/peer-ingress.test.ts）：带凭据就必须是 peer；没带交给 API（兑换邀请 / 401） */
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
 * 对外也只多出 peer token + 兑换邀请这一小块——主端口的控制面、ws、全权 token 都不在这个入口上。
 */
export function ingressHost(publicFlag: boolean, hasPeers: boolean, holdUntil: number, now: number): Host {
  return publicFlag && (hasPeers || now < holdUntil) ? "0.0.0.0" : "127.0.0.1";
}

const HOLD_MS = 10 * 60_000;
let handler: ApiHandler | null = null;
let cur: { srv: ReturnType<typeof serve>; port: number; host: Host } | null = null;
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
async function syncPeerIngress(hold = false): Promise<{ port: number | null; host: Host | null }> {
  if (hold) holdUntil = Date.now() + HOLD_MS;
  const port = configuredPeerIngressPort({ PEER_INGRESS_PORT: repoEnvVar("PEER_INGRESS_PORT") });
  const host = port ? ingressHost(repoEnvVar("PEER_INGRESS_PUBLIC") === "1", await hasPeerTokens(), holdUntil, Date.now()) : null;
  if (cur && cur.port === port && cur.host === host) return { port, host };
  cur?.srv.stop(true);
  cur = null;
  if (!port || !host || !handler) return { port, host: null };
  try {
    cur = { srv: serve({ port, host, handleApi: handler }), port, host };
    const how = host === "0.0.0.0" ? "对外直连，只收 peer token" : "只听本机，供 HTTPS 反代转发";
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

function serve(opts: { port: number; host: Host; handleApi: ApiHandler }) {
  return Bun.serve({
    port: opts.port,
    hostname: opts.host,
    async fetch(req) {
      if (req.headers.get("upgrade")) return json(400, { ok: false, error: "no websocket on the peer entrance" });
      const raw = new URL(req.url);
      const url = new URL(ingressApiPath(raw.pathname) + raw.search, raw.origin);
      const secret = ingressSecret(req, url);
      const principal = secret ? findByBearer(await readPrincipals(), secret) : null;
      if (ingressVerdict(secret, principal) === "not-peer") {
        return json(403, { ok: false, error: "this entrance only serves peer tokens" });
      }
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
      return opts.handleApi(new Request(url.toString(), { method: req.method, headers: req.headers, body }), url);
    },
  });
}
