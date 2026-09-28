/**
 * 收方的接线（docs/relay/e2e-design.md §5.1）：/api/v1/e2e/* 在 serveApiRequest 里最先处理，解开的内层请求带上
 * 「来自哪个会话」再交回原路由，于是 authApi 照旧验内层的 Bearer、签名与重放，peerGate 再核 token 的主人 = 会话发起方
 * （lib/peer-e2e-local.ts peerE2eRefusal）。三个入口（主端口、peer 入口、中继经 peer 入口）都汇到这里；
 * 浏览器的路径模式（source=relay）一律 403——那是 P2 的事，这里只收 peer。状态可注入，集成测试直接 import（tests/peer-e2e-relay.test.ts）。
 */
import { SIG_HEADERS, verifySigned } from "../lib/instance-key.js";
import { e2ePeerOf, localE2e, pinPeerE2eKey, readHttpPeers, type LocalE2e } from "../lib/peer-e2e-local.js";
import { serveE2e, type E2ePeer } from "../lib/peer-e2e-serve.js";
import { SessionTable } from "../lib/peer-e2e-sessions.js";
import { e2eError } from "../lib/peer-e2e-wire.js";
import { ReplayCache } from "../lib/peer-trust.js";
import type { HttpPeer } from "../lib/peers.js";
import { requestContextOf, setRequestContext } from "./request-context.js";

export interface RouteDeps {
  local: () => Promise<LocalE2e | null>;
  peers: () => Promise<HttpPeer[]>;
  pin: typeof pinPeerE2eKey;
  now?: () => number;
}

export type InnerHandler = (inner: Request) => Promise<Response>;

export function createE2eRoute(d: RouteDeps) {
  const sessions = new SessionTable({}, d.now);
  /** hello 的外层签名只认一次（中继路径上 relay-inbound 另有一份，两份各见一次不算重放） */
  const helloReplays = new ReplayCache();
  let byFp = new Map<string, E2ePeer>();

  /** 每个请求现读 peers.json：消失 / 禁用 / 换了钥匙的 peer，会话立即作废 */
  async function refresh(): Promise<void> {
    const next = new Map<string, E2ePeer>();
    for (const p of (await d.peers()).map(e2ePeerOf)) if (p) next.set(p.fp, p);
    for (const [fp, old] of byFp) if (next.get(fp)?.ek.pub !== old.ek.pub) sessions.dropPeer(fp);
    byFp = next;
  }

  function outerSigned(req: Request, body: Uint8Array, idk: string): boolean {
    const h = (k: string) => req.headers.get(k) ?? "";
    if (h(SIG_HEADERS.key) !== idk) return false;
    const u = new URL(req.url);
    if (verifySigned(idk, { method: req.method, path: u.pathname + u.search, ts: h(SIG_HEADERS.ts), sig: h(SIG_HEADERS.sig), body }) !== "ok") return false;
    return helloReplays.verdict(h(SIG_HEADERS.sig), h(SIG_HEADERS.ts), (d.now ?? Date.now)()) === null;
  }

  /** 不是 /api/v1/e2e/* → null；handle = 原路由（内层请求从头走一遍鉴权） */
  async function route(req: Request, url: URL, handle: InnerHandler): Promise<Response | null> {
    if (!url.pathname.startsWith("/api/v1/e2e/")) return null;
    const ctx = requestContextOf(req);
    if (ctx.source === "relay") return e2eError(403, "e2e_via_relay_path");
    const local = await d.local();
    if (!local) return e2eError(503, "e2e_unavailable");
    await refresh();
    return serveE2e(req, url.pathname, {
      myFp: local.fp,
      machine: async () => local.machine,
      mySignedKey: async () => local.signed,
      sessions,
      peerByFp: (fp) => byFp.get(fp) ?? null,
      pinNewer: (p, ek) => d.pin(p.name, ek),
      outerSigned,
      dispatch: (inner, peerFp) => {
        setRequestContext(inner, { ...ctx, e2e: { peerFp } });
        return handle(inner);
      },
    }, ctx.relayFrom !== undefined ? { relayFrom: ctx.relayFrom } : {});
  }

  return { route };
}

const live = createE2eRoute({ local: () => localE2e(), peers: readHttpPeers, pin: pinPeerE2eKey });

/** api-routes.ts serveApiRequest 调它，一行接入 */
export const peerE2eRoute = (req: Request, url: URL, handle: InnerHandler): Promise<Response | null> => live.route(req, url, handle);
