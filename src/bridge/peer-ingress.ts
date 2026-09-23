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
 */
import { findByBearer, readPrincipals } from "../lib/principals.js";

export { configuredPeerIngressPort } from "../lib/bridge-url.js";

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

/** port 为 null（.env 没配 PEER_INGRESS_PORT）就不开；起不来（端口被占等）只记日志：附加能力，不能拖垮 bridge */
export function startPeerIngress(opts: { port: number | null; handleApi: (req: Request, url: URL) => Promise<Response> }) {
  if (!opts.port) return null;
  try {
    const srv = serve({ port: opts.port, handleApi: opts.handleApi });
    console.log(`🤝 peer 入口: http://127.0.0.1:${opts.port}（只服务 /api/v1 + peer token，供 HTTPS 反代转发）`);
    return srv;
  } catch (e) {
    console.error(`⚠️ peer 入口起不来（127.0.0.1:${opts.port}）: ${(e as Error).message}——peer 只能走 bridge 主端口`);
    return null;
  }
}

function serve(opts: { port: number; handleApi: (req: Request, url: URL) => Promise<Response> }) {
  return Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1", // 只给本机反代用，永远不对外
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
