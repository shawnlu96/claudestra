/**
 * 经中继送进来的请求在本机怎么走（docs/relay/protocol.md §4）：
 *   - from = "relay" 且带模式头 api：路径模式 https://<base>/m/<fp>/api/v1/…，在进程内直接调 API（relay-dispatch.ts），
 *     身份由设备凭据 / Bearer 决定；
 *   - from = "relay" 没有模式头：旧子域名隧道，原样重放到本机 Web（Next.js），身份由 Web 自己的会话 cookie 决定；
 *   - from = 对方指纹：peer 调 /api/v1，先验签（指纹 ↔ 签名头公钥 ↔ 签名），再核发件人（联系人、token 归属），
 *     最后打 peer 专用回环入口。
 * 纯逻辑（验签、重放缓存）单独导出给 tests/relay-link.test.ts；fetch 可注入。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { SIG_HEADERS, isPublicKey, keyFingerprint, verifySigned } from "../lib/instance-key.js";
import { RELAY_BASE_HEADER, RELAY_FROM, RELAY_FROM_HEADER, apiPathOk, isRedeemRequest, type Headers } from "../lib/relay-protocol.js";
import { RELAY_MODE_API, RELAY_MODE_HEADER } from "../lib/relay-machine-path.js";
import { ReplayCache } from "../lib/peer-trust.js";
import { LogThrottle } from "../lib/log-throttle.js";
import { collectBody, dropForPeer, forwardHeaders, headersToObject, rewriteLocation } from "../lib/relay-stream.js";
import { RelayError, type InboundContext, type InboundHandler, type InboundRequest, type InboundResponse } from "../lib/relay-client-types.js";
import { dispatchMachineRequest, type ApiHandler } from "./relay-dispatch.js";
import { setRequestContext } from "./request-context.js";
import { isDirectLoopback } from "../lib/same-host.js";
import { RELAY_SIG_DETAIL } from "../lib/peer-auth-hints.js";

export { ReplayCache };

/**
 * 兑换帧的防重放缓存：中继对每个发件人每分钟只放 6 条兑换，一个发件人在签名有效期内最多约 60 条。满了挤掉最旧的一条，
 * 不拒新兑换：兑换本身另有两道兜底——口令只能兑换一次，持钥证明绑着加入方现生成的 nonce——被挤掉的那条签名再来一次，
 * 最多得到和原请求相同的结果；拒新兑换的话，非联系人用几个身份灌满就能挡住所有经中继的兑换。
 */
const REDEEM_REPLAY_MAX = 500;
const REDEEM_REPLAY_PER_SENDER = 60;

const refusalLog = new LogThrottle();

/** peer 请求正文上限：验签要整读，别让对方灌满内存（peer 路径的正文都是小 JSON） */
const MAX_PEER_BODY = 2 * 1024 * 1024;

/**
 * 只有经中继进来的 peer 请求才带的标记头。peer 入口靠它决定要不要相信 x-claudestra-relay-from：
 * 直连（Tailscale / Caddy）进来的 peer 也能自己写那个头，把任意指纹塞进兑换记录的联系人名单。
 * 标记是进程内随机值：不落盘、不进配置，bridge 重启就换，本机之外没人知道。
 */
export const RELAY_MARK_HEADER = "x-claudestra-relay-mark";
let mark: string | null = null;

export function relayMark(): string {
  return (mark ??= randomBytes(32).toString("base64url"));
}

/** 标记比对用常量时间（长度不同直接不等：标记是定长的，长度本身不泄露什么） */
function markEquals(got: string | null, expected: string): boolean {
  if (!got || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

/**
 * 隧道请求的标记头（另一个进程内随机值：隧道可能打到还没迁移的旧 web 服务，不能把 peer 入口那个标记也交出去）。
 * bridge 主端口 / 旧 web 端口认出它，就把这个请求的来源定成 relay——中继自己选走隧道还是路径模式，
 * 两条路进 bridge 后的待遇必须一样（peer token 403、不算本机、不算同机）。
 */
export const TUNNEL_MARK_HEADER = "x-claudestra-tunnel-mark";
let tunnelMarkValue: string | null = null;
const tunnelMark = (): string => (tunnelMarkValue ??= randomBytes(32).toString("base64url"));

/**
 * bridge 主端口与接管的旧 web 端口给每个请求定来源，返回这个请求算不算本机（控制面闸门用）。bridge.ts 只调这一个，
 * 测试也调它：来源必须每个请求都设——隧道、反代、局域网请求都带 XFF 或不是回环，设上下文要是排在「是不是直连回环」
 * 之后就会整批漏设。本机 = 回环 socket、没有 XFF、也不带隧道标记（标记头核完就删，不往后传；tests/relay-entry-trust.test.ts）。
 */
export function socketTrust(req: Request, addr: string | null): boolean {
  const direct = isDirectLoopback(addr, req.headers.get("x-forwarded-for"));
  const tunnel = markEquals(req.headers.get(TUNNEL_MARK_HEADER), tunnelMark());
  req.headers.delete(TUNNEL_MARK_HEADER);
  const https = req.headers.get("x-forwarded-proto") === "https";
  if (!tunnel) setRequestContext(req, { source: direct ? "loopback" : "lan", clientIp: addr, https });
  else setRequestContext(req, { source: "relay", clientIp: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null, https: true });
  return direct && !tunnel;
}

/**
 * peer 入口用：标记对得上才返回来源指纹，否则 null（可能是直连 peer 伪造的）。两个头都从 h 里删掉——
 * 指纹只经请求上下文（request-context.ts relayFrom）往下传，任何入口的原始头都不会被当成来源。
 */
export function takeRelayFrom(h: globalThis.Headers, expectedMark: string): string | null {
  const from = markEquals(h.get(RELAY_MARK_HEADER), expectedMark) ? h.get(RELAY_FROM_HEADER) : null;
  h.delete(RELAY_MARK_HEADER);
  h.delete(RELAY_FROM_HEADER);
  return from || null;
}

export interface InboundDeps {
  /** 本机 Web：http://127.0.0.1:<webPort> */
  webBase: string;
  /** peer 专用回环入口；没配端口返回 null → local_unreachable */
  ingressBase: () => string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** 一次兑换邀请成功后调（联系人清单变了，要重发给中继） */
  onRedeemed?: () => void;
  /** 路径模式请求的进程内 API 处理器（bridge.ts 注入：终端端点 + serveApiRequest）；没注入就只有旧隧道 */
  handleApi?: ApiHandler;
  /** 验签之后的发件人核对（联系人、token 归属，lib/peer-trust.ts relayPeerRefusal）：返回拒绝原因或 null */
  refusePeer: (from: string, req: { method: string; path: string; headers: Headers }) => Promise<string | null>;
  /** 防重放缓存（测试注入小容量的）；不给就按默认容量新建 */
  caches?: Caches;
}

/** §4.1 第 1、2 步：签名头公钥的指纹必须等于中继盖的 from，签名必须对得上。只验不记，防重放在核过发件人之后（recordPeerReplay） */
export function verifyPeerSignature(from: string, req: { method: string; path: string; headers: Headers; body: Uint8Array }, now: number): RelayError | null {
  const key = req.headers[SIG_HEADERS.key];
  const ts = req.headers[SIG_HEADERS.ts];
  const sig = req.headers[SIG_HEADERS.sig];
  if (!key || !ts || !sig) return new RelayError("bad_signature", "peer", RELAY_SIG_DETAIL.missing);
  if (!isPublicKey(key) || keyFingerprint(key) !== from) return new RelayError("bad_signature", "peer", RELAY_SIG_DETAIL.foreignKey);
  const r = verifySigned(key, { method: req.method, path: req.path, ts, sig, body: req.body }, now);
  if (r !== "ok") return new RelayError("bad_signature", "peer", r === "stale" ? RELAY_SIG_DETAIL.stale : RELAY_SIG_DETAIL.mismatch);
  return null;
}

/**
 * §4.1 第 4 步：非 GET/HEAD 的签名只认一次。只在发件人核过之后调——被拒的请求一条都不进缓存，
 * 非联系人进不来；兑换帧（非联系人也能发）记在单独的小缓存里，满了只拒兑换，联系人的额度不受影响。
 */
export function recordPeerReplay(from: string, req: { method: string; headers: Headers }, cache: ReplayCache, now: number): RelayError | null {
  if (req.method === "GET" || req.method === "HEAD") return null;
  const seen = cache.seen(req.headers[SIG_HEADERS.sig]!, req.headers[SIG_HEADERS.ts]!, now, from);
  if (seen === "full") return new RelayError("replay_full", "peer", "replay cache full, retry later");
  if (seen === "before_start") return new RelayError("bad_signature", "peer", RELAY_SIG_DETAIL.beforeStart);
  if (seen) return new RelayError("replay", "peer", "signature already used");
  return null;
}

/**
 * 帧里的 path 拼到本机地址上：必须以 / 开头、不以 // 开头，拼出来的 origin 还得是 base 的——不这样卡，
 * path 就能改写目标主机，让 bridge 替中继去请求别的地址（tests/relay-link.test.ts）。
 */
export function localUrl(base: string, path: string): string {
  const bad = (): RelayError => new RelayError("path_forbidden", "peer", "path must be an absolute path on this instance");
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) throw bad();
  let u: URL;
  try {
    u = new URL(path, base);
  } catch {
    throw bad(); // 拼不成合法 URL：同样不是本机上的路径
  }
  if (u.origin !== new URL(base).origin) throw bad();
  return u.toString();
}

/** fetch 抛出来的错 → 协议错误码：被 abort 的算超时，其余算连不上本机 */
function localError(e: unknown, signal: AbortSignal): RelayError {
  if (signal.aborted) return new RelayError("local_timeout", "peer", "cancelled while calling local service");
  return new RelayError("local_unreachable", "peer", (e as Error).message);
}

/** peer 路径的响应由 fetch 解压后再转，content-encoding 就不能再带（对方按头解一次就坏了） */
const dropForResponse = (k: string): boolean => k === "content-encoding";
/** 隧道路径让压缩正文原样过：Bun 的 fetch 支持 decompress:false，浏览器自己解——JS 块经此少传六成，慢上行的机器体感差别很大 */
const TUNNEL_FETCH: Record<string, unknown> = typeof Bun !== "undefined" ? { decompress: false } : {};
/** 中继没给客户端地址时的 XFF 占位（RFC 7239 的 unknown）：不是 IP，同机判定（lib/same-host.ts）也认不成本机 */
const TUNNEL_UNKNOWN_CLIENT = "unknown";

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
  const target = localUrl(d.webBase, req.path);
  // 网页端口和 peer 入口撞在一起时拒绝隧道：入口把回环 socket 来的请求当本机反代（peer-ingress.ts），隧道不能落到那里
  const ingress = d.ingressBase();
  if (ingress && new URL(ingress).origin === new URL(d.webBase).origin) throw new RelayError("local_unreachable", "peer", "web port is the peer ingress port on this instance");
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  // 浏览器看到的主机名以中继盖的 x-forwarded-host 为准（front 已剥掉客户端自带的）；Host 也改成它，
  // 本机 Web 才会按公网地址算相对跳转，而不是按它自己的回环监听地址
  const publicHost = req.headers["x-forwarded-host"] || req.headers.host || "";
  // 帧里的 x-claudestra-* 只放行中继主机名（§4.2 约定给本机 Web 的）；别的内部头（来源、标记……）一律不往本机 Web 传
  const headers = forwardHeaders(req.headers, (k) => k.startsWith("x-claudestra-") && k !== RELAY_BASE_HEADER);
  if (publicHost) headers.host = publicHost;
  headers[TUNNEL_MARK_HEADER] = tunnelMark();
  // 隧道打的是回环端口，而且可能正是 bridge 接管的旧 web 端口：bridge 只把「回环 + 无 XFF」认作本机（web-gateway.ts
  // isDirectLoopback），所以这里无论中继带没带都写一个非空 XFF，隧道请求永远不会被当成本机进程（tests/relay-link.test.ts）
  headers["x-forwarded-for"] = headers["x-forwarded-for"]?.trim() || TUNNEL_UNKNOWN_CLIENT;
  // Node 的 fetch 没有 decompress 开关会自动解压：那时不能把 accept-encoding 传过去，否则 content-encoding 头对不上正文
  if (!("decompress" in TUNNEL_FETCH)) delete headers["accept-encoding"];
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
    redirect: "manual",
    signal: ctx.signal,
    ...TUNNEL_FETCH,
    ...(hasBody ? { body: req.body, duplex: "half" } : {}),
  };
  let r: Response;
  try {
    r = await fetchImpl(target, init);
  } catch (e) {
    throw localError(e, ctx.signal);
  }
  const out = rewriteLocation(forwardHeaders(headersToObject(r.headers), "decompress" in TUNNEL_FETCH ? undefined : dropForResponse), publicHost);
  return { status: r.status, headers: rewriteLocalLocation(out, d.webBase, publicHost), body: r.body };
}

type Caches = { peer: ReplayCache; redeem: ReplayCache };

async function forwardPeer(from: string, req: InboundRequest, ctx: InboundContext, d: InboundDeps, caches: Caches): Promise<InboundResponse> {
  if (!apiPathOk(req.path)) throw new RelayError("path_forbidden", "peer", `${req.path} is not under /api/v1`);
  const base = d.ingressBase();
  if (!base) throw new RelayError("local_unreachable", "peer", "peer ingress port not configured on this instance");
  // 拼目标地址在验签和记防重放之前：路径不合格直接报 path_forbidden，不占缓存，也不会被下面的 fetch 错误改写成连不上本机
  const target = localUrl(base, req.path);
  let body: Uint8Array;
  try {
    body = await collectBody(req.body, MAX_PEER_BODY);
  } catch (e) {
    throw new RelayError("payload_too_large", "peer", (e as Error).message);
  }
  const now = (d.now ?? Date.now)();
  const bad = verifyPeerSignature(from, { method: req.method, path: req.path, headers: req.headers, body }, now);
  if (bad) throw bad;
  const refused = await d.refusePeer(from, req);
  if (refused) {
    // 细节只进本机日志：对外同一句，不让联系人借此试探 token。每个发件人每分钟一行（lib/log-throttle.ts）
    const log = refusalLog.take(from, now);
    if (log) console.warn(`🚫 [relay] ${log.key} ${req.method} ${req.path.split("?")[0]}: ${refused}${log.muted ? `（上一分钟另有 ${log.muted} 条被拒）` : ""}`);
    throw new RelayError("sender_forbidden", "peer", "sender is not allowed to make this request");
  }
  const replay = recordPeerReplay(from, req, isRedeemRequest(req.method, req.path) ? caches.redeem : caches.peer, now);
  if (replay) throw replay;
  const headers = forwardHeaders(req.headers, dropForPeer);
  headers[RELAY_FROM_HEADER] = from;
  headers[RELAY_MARK_HEADER] = relayMark();
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let r: Response;
  try {
    r = await (d.fetchImpl ?? fetch)(target, { method: req.method, headers, redirect: "manual", signal: ctx.signal, ...(hasBody ? { body } : {}) });
  } catch (e) {
    throw localError(e, ctx.signal);
  }
  if (r.ok && isRedeemRequest(req.method, req.path)) d.onRedeemed?.();
  return { status: r.status, headers: forwardHeaders(headersToObject(r.headers), dropForResponse), body: r.body };
}

export function makeInboundHandler(d: InboundDeps): InboundHandler {
  const caches: Caches = d.caches ?? { peer: new ReplayCache(), redeem: new ReplayCache(REDEEM_REPLAY_MAX, undefined, undefined, REDEEM_REPLAY_PER_SENDER, true) };
  return (req, ctx) => {
    if (ctx.from !== RELAY_FROM) return forwardPeer(ctx.from, req, ctx, d, caches);
    const pathMode = req.headers[RELAY_MODE_HEADER] === RELAY_MODE_API;
    return pathMode && d.handleApi ? dispatchMachineRequest(req, ctx, d.handleApi) : forwardTunnel(req, ctx, d);
  };
}
