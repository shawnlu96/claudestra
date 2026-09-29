/**
 * 收方的接线（docs/relay/e2e-design.md §5.1）：/api/v1/e2e/* 在 serveApiRequest 里最先处理，解开的内层请求带上
 * 「来自哪个会话」再交回原路由，于是 authApi 照旧验内层的 Bearer、签名与重放，peerGate 再核 token 的主人 = 会话发起方
 * （lib/peer-e2e-local.ts peerE2eRefusal）。三个入口（主端口、peer 入口、中继经 peer 入口）都汇到这里；来源与 peer token 同一张白名单
 * （request-context.ts sourceAllows "peer"）：浏览器的路径模式、隧道、判不出来源的一律 403——那是 P2 的事，这里只收 peer。
 * E2E 帧外层不带 token（token 只在密文里），两道「不带凭据只放兑换」的闸为它开了逐字匹配的口子（lib/peer-e2e-wire.ts isE2eFrame），
 * 所以外层身份在这里、在任何解析和 ECDH 之前核：中继帧由 relay-inbound 核过（验签、联系人、记下的钥匙、防重放），直连的在 directSender 核。
 * 状态可注入，集成测试直接 import（tests/peer-e2e-relay.test.ts）。
 */
import { isPublicKey, keyFingerprint, SIG_HEADERS, verifySigned } from "../lib/instance-key.js";
import { e2ePeerOf, localE2e, pinPeerE2eKey, readHttpPeers, type LocalE2e } from "../lib/peer-e2e-local.js";
import { e2eBodyCap, readRequestCapped, serveE2e, type E2ePeer } from "../lib/peer-e2e-serve.js";
import { SessionTable } from "../lib/peer-e2e-sessions.js";
import { E2E_HELLO_PATH, e2eError, isE2eFrame } from "../lib/peer-e2e-wire.js";
import { ReplayCache } from "../lib/peer-trust.js";
import type { HttpPeer } from "../lib/peers.js";
import { SlidingWindowLimiter } from "../lib/principals.js";
import { sigFailureAllowed } from "./api-auth.js";
import { requestContextOf, setRequestContext, sourceAllows } from "./request-context.js";

/** 每个发件人每分钟最多几次 hello（每次要做 ECDH）：会话一天一换，对方重启、每条 manager 命令各握一次，这个数只挡异常的连发 */
const HELLO_PER_SENDER = 20;
const MAX_SENDERS = 2_000;

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
  const helloLimits = new Map<string, SlidingWindowLimiter>();

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
    return helloReplays.seen(h(SIG_HEADERS.sig), h(SIG_HEADERS.ts), (d.now ?? Date.now)(), idk) === false; // 满了（full）同样拒
  }

  /**
   * 直连来的（主端口、peer 入口直连）外层身份：签名钥匙必须是某个 E2E 联系人钉住的身份钥匙、签名对得上，才往下走。
   * 失败计入 peerGate 的验签失败桶（bridge/api-auth.ts，认得出的按联系人名、认不出的按来源地址），什么都不写。返回验过的指纹或拒绝响应。
   * hello 的防重放也在这里、在扣 hello 限速之前：截获一个 hello 反复重放，耗不掉这个发件人（中继、直连共用）的握手额度
   */
  async function directSender(req: Request, url: URL, clientIp: string | null, body: Uint8Array): Promise<string | Response> {
    const h = (k: string) => req.headers.get(k) ?? "";
    const key = h(SIG_HEADERS.key);
    const peer = isPublicKey(key) ? byFp.get(keyFingerprint(key)) : undefined;
    if (peer && peer.idk === key && verifySigned(key, { method: req.method, path: url.pathname + url.search, ts: h(SIG_HEADERS.ts), sig: h(SIG_HEADERS.sig), body }) === "ok") {
      const replayed = url.pathname === E2E_HELLO_PATH && helloReplays.seen(h(SIG_HEADERS.sig), h(SIG_HEADERS.ts), (d.now ?? Date.now)(), key) !== false;
      return replayed ? e2eError(401, "e2e_signature") : peer.fp; // 重放与缓存满（full）同 outerSigned 一样拒，不另开 code
    }
    return sigFailureAllowed(peer ? peer.name : `ip:${clientIp ?? "unknown"}`) ? e2eError(401, "e2e_signature") : e2eError(429, "e2e_rate_limited");
  }

  function helloAllowed(fp: string): boolean {
    let l = helloLimits.get(fp);
    if (!l) {
      if (helloLimits.size >= MAX_SENDERS) helloLimits.delete(helloLimits.keys().next().value!);
      helloLimits.set(fp, (l = new SlidingWindowLimiter(HELLO_PER_SENDER, 60_000)));
    }
    return l.tryAcquire();
  }

  /** 不是 /api/v1/e2e/* → null；handle = 原路由（内层请求从头走一遍鉴权） */
  async function route(req: Request, url: URL, handle: InnerHandler): Promise<Response | null> {
    if (!url.pathname.startsWith("/api/v1/e2e/")) return null;
    if (!sourceAllows(req, "peer")) return e2eError(403, "e2e_via_relay_path");
    if (!isE2eFrame(req.method, url.pathname + url.search)) return e2eError(404, "e2e_path");
    const ctx = requestContextOf(req);
    const local = await d.local();
    if (!local) return e2eError(503, "e2e_unavailable");
    await refresh();
    // 先认外层发件人（验签），再按发件人给 hello 限速，之后才轮到解析与 ECDH（lib/peer-e2e-serve.ts）。
    // 直连的外层身份要看正文，读之前先按帧封顶（没验过签的人塞不进大正文）；中继帧的正文 relay-inbound 已经封过
    const body = ctx.relayFrom ? undefined : await readRequestCapped(req, e2eBodyCap(url.pathname));
    if (body === null) return e2eError(413, "e2e_too_large");
    const sender = ctx.relayFrom ?? (await directSender(req, url, ctx.clientIp, body!));
    if (sender instanceof Response) return sender;
    if (url.pathname === E2E_HELLO_PATH && !helloAllowed(sender)) return e2eError(429, "e2e_rate_limited");
    return serveE2e(req, url.pathname, {
      myFp: local.fp,
      machine: async () => local.machine,
      mySignedKey: async () => local.signed,
      sessions,
      peerByFp: (fp) => byFp.get(fp) ?? null,
      pinNewer: (p, ek) => d.pin(p.name, ek),
      // 直连的 hello 在 directSender 里验过签、记过重放，这里再记一次就成了「重放」：只核钥匙是同一把
      outerSigned: body ? (r, _b, idk) => r.headers.get(SIG_HEADERS.key) === idk : outerSigned,
      dispatch: (inner, peerFp) => {
        setRequestContext(inner, { ...ctx, e2e: { peerFp } });
        return handle(inner);
      },
    }, { sender, body });
  }

  return { route };
}

const live = createE2eRoute({ local: () => localE2e(), peers: readHttpPeers, pin: pinPeerE2eKey });

/** api-routes.ts serveApiRequest 调它，一行接入 */
export const peerE2eRoute = (req: Request, url: URL, handle: InnerHandler): Promise<Response | null> => live.route(req, url, handle);
