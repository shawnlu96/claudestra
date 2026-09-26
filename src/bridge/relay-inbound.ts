/**
 * 经中继送进来的请求在本机怎么走（docs/relay/protocol.md §4）：
 *   - from = "relay"：浏览器打到 https://<slug>.<base>/… 的隧道流量，原样重放到本机 Web（Next.js），不验签——
 *     身份由 Web 自己的会话 cookie 决定，与 Tailscale 直连时一样；响应流式回传（SSE 靠这个）。
 *   - from = 对方指纹：peer 调 /api/v1，先验签（指纹 ↔ 签名头公钥 ↔ 签名）再打 peer 专用回环入口。
 * 纯逻辑（验签、重放缓存）单独导出给 tests/relay-link.test.ts；fetch 可注入。
 */
import { SIG_HEADERS, isPublicKey, keyFingerprint, verifySigned } from "../lib/instance-key.js";
import { RELAY_FROM, RELAY_FROM_HEADER, apiPathOk, isRedeemRequest, type Headers } from "../lib/relay-protocol.js";
import { collectBody, dropForPeer, forwardHeaders, headersToObject, rewriteLocation } from "../lib/relay-stream.js";
import { RelayError, type InboundContext, type InboundHandler, type InboundRequest, type InboundResponse } from "../lib/relay-client-types.js";

/** peer 请求正文上限：验签要整读，别让对方灌满内存（peer 路径的正文都是小 JSON） */
const MAX_PEER_BODY = 2 * 1024 * 1024;
const REPLAY_TTL_MS = 10 * 60_000;

export interface InboundDeps {
  /** 本机 Web：http://127.0.0.1:<webPort> */
  webBase: string;
  /** peer 专用回环入口；没配端口返回 null → local_unreachable */
  ingressBase: () => string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** 一次兑换邀请成功后调（联系人清单变了，要重发给中继） */
  onRedeemed?: () => void;
}

/** 非幂等方法的签名 10 分钟内只认一次（签名含时间戳与正文哈希，同一 sig = 同一请求） */
export class ReplayCache {
  private readonly seenAt = new Map<string, number>();
  constructor(private readonly ttlMs = REPLAY_TTL_MS) {}

  /** true = 见过（重放） */
  seen(sig: string, now: number): boolean {
    for (const [k, t] of this.seenAt) if (now - t > this.ttlMs) this.seenAt.delete(k);
    if (this.seenAt.has(sig)) return true;
    this.seenAt.set(sig, now);
    return false;
  }
}

/** §4.1：签名头公钥的指纹必须等于中继盖的 from，签名必须对得上，非 GET/HEAD 不许重放 */
export function verifyPeerRequest(
  from: string,
  req: { method: string; path: string; headers: Headers; body: Uint8Array },
  cache: ReplayCache,
  now: number,
): RelayError | null {
  const key = req.headers[SIG_HEADERS.key];
  const ts = req.headers[SIG_HEADERS.ts];
  const sig = req.headers[SIG_HEADERS.sig];
  if (!key || !ts || !sig) return new RelayError("bad_signature", "peer", "signature headers missing");
  if (!isPublicKey(key) || keyFingerprint(key) !== from) return new RelayError("bad_signature", "peer", "signing key does not match sender");
  const r = verifySigned(key, { method: req.method, path: req.path, ts, sig, body: req.body }, now);
  if (r !== "ok") return new RelayError("bad_signature", "peer", r === "stale" ? "timestamp outside ±300 s" : "signature mismatch");
  const idempotent = req.method === "GET" || req.method === "HEAD";
  if (!idempotent && cache.seen(sig, now)) return new RelayError("replay", "peer", "signature seen within 10 minutes");
  return null;
}

/** fetch 抛出来的错 → 协议错误码：被 abort 的算超时，其余算连不上本机 */
function localError(e: unknown, signal: AbortSignal): RelayError {
  if (signal.aborted) return new RelayError("local_timeout", "peer", "cancelled while calling local service");
  return new RelayError("local_unreachable", "peer", (e as Error).message);
}

const dropForTunnelReq = (k: string): boolean => k === "accept-encoding"; // 让 Web 回未压缩正文：fetch 会解码，再带 content-encoding 头浏览器就解两次
const dropForResponse = (k: string): boolean => k === "content-encoding";

/** 本机 Web 按自己的监听地址算出的绝对 Location（http://127.0.0.1:3333/…）也改到公网地址，浏览器才不会跳到它连不上的回环 */
function rewriteLocalLocation(headers: Headers, webBase: string, publicHost: string): Headers {
  const loc = headers.location;
  if (!loc || !publicHost) return headers;
  const base = webBase.replace(/\/+$/, "").toLowerCase();
  if (loc.toLowerCase() === base || loc.toLowerCase().startsWith(`${base}/`)) return { ...headers, location: `https://${publicHost}${loc.slice(base.length)}` };
  return headers;
}

async function forwardTunnel(req: InboundRequest, ctx: InboundContext, d: InboundDeps): Promise<InboundResponse> {
  const fetchImpl = d.fetchImpl ?? fetch;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  // 浏览器看到的主机名以中继盖的 x-forwarded-host 为准（front 已剥掉客户端自带的）；Host 也改成它，
  // 本机 Web 才会按公网地址算相对跳转，而不是按它自己的回环监听地址
  const publicHost = req.headers["x-forwarded-host"] || req.headers.host || "";
  const headers = forwardHeaders(req.headers, dropForTunnelReq);
  if (publicHost) headers.host = publicHost;
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
    redirect: "manual",
    signal: ctx.signal,
    ...(hasBody ? { body: req.body, duplex: "half" } : {}),
  };
  let r: Response;
  try {
    r = await fetchImpl(`${d.webBase}${req.path}`, init);
  } catch (e) {
    throw localError(e, ctx.signal);
  }
  const out = rewriteLocation(forwardHeaders(headersToObject(r.headers), dropForResponse), publicHost);
  return { status: r.status, headers: rewriteLocalLocation(out, d.webBase, publicHost), body: r.body };
}

async function forwardPeer(from: string, req: InboundRequest, ctx: InboundContext, d: InboundDeps, cache: ReplayCache): Promise<InboundResponse> {
  if (!apiPathOk(req.path)) throw new RelayError("path_forbidden", "peer", `${req.path} is not under /api/v1`);
  let body: Uint8Array;
  try {
    body = await collectBody(req.body, MAX_PEER_BODY);
  } catch (e) {
    throw new RelayError("payload_too_large", "peer", (e as Error).message);
  }
  const bad = verifyPeerRequest(from, { method: req.method, path: req.path, headers: req.headers, body }, cache, (d.now ?? Date.now)());
  if (bad) throw bad;
  const base = d.ingressBase();
  if (!base) throw new RelayError("local_unreachable", "peer", "peer ingress port not configured on this instance");
  const headers = forwardHeaders(req.headers, dropForPeer);
  headers[RELAY_FROM_HEADER] = from;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let r: Response;
  try {
    r = await (d.fetchImpl ?? fetch)(`${base}${req.path}`, { method: req.method, headers, redirect: "manual", signal: ctx.signal, ...(hasBody ? { body } : {}) });
  } catch (e) {
    throw localError(e, ctx.signal);
  }
  if (r.ok && isRedeemRequest(req.method, req.path)) d.onRedeemed?.();
  return { status: r.status, headers: forwardHeaders(headersToObject(r.headers), dropForResponse), body: r.body };
}

export function makeInboundHandler(d: InboundDeps): InboundHandler {
  const cache = new ReplayCache();
  return (req, ctx) => (ctx.from === RELAY_FROM ? forwardTunnel(req, ctx, d) : forwardPeer(ctx.from, req, ctx, d, cache));
}
