/**
 * 中继客户端：让两台 bridge 不靠 Tailscale 直连也能互调 /api/v1（协议与服务端在 claudestra-relay 仓库，
 * 这个文件是它 src/client/relay-client.ts 的镜像，只有两处不同：公钥 / 指纹 / 请求验签直接用 ./instance-key.js，
 * 以及内部函数不导出。改协议要两边一起改，relay 仓库 docs/protocol.md §11 的向量是对拍依据）。
 *
 * 职责：出站 WSS + Ed25519 挑战应答登录、心跳、退避重连；request() 的帧收发与超时；入站 req 先验签再打本机 peer 入口
 * （bridge/peer-ingress.ts 的回环端口）。不代签出站请求——签名是 bridge 的身份，调用方用 signedHeaders 签好传进来；
 * 不落盘、不读 .env，配置全由 bridge/relay-link.ts 传入。
 */
import { createHash, sign, type KeyObject } from "node:crypto";
import { hostname } from "node:os";
import { isPublicKey, keyFingerprint, verifySigned } from "./instance-key.js";

interface RelayKey { publicKey: string; privateKey: KeyObject }
export interface RelayRequest { method: string; path: string; headers: Record<string, string>; body: Uint8Array }
export interface RelayResponse { status: number; headers: Record<string, string>; body: Uint8Array }
interface RelayPeer { fp: string; key: string; name: string; online: boolean; lastSeen: string }
type RelayState = "connecting" | "online" | "offline" | "closed";
type RelayErrorOrigin = "relay" | "peer" | "client";
interface InboundContext { from: string; signal: AbortSignal; timeoutMs: number }
type InboundHandler = (req: RelayRequest, ctx: InboundContext) => Promise<RelayResponse>;

export class RelayError extends Error {
  constructor(public readonly code: string, public readonly origin: RelayErrorOrigin, message?: string) {
    super(message ?? code);
    this.name = "RelayError";
  }
}

export interface ConnectOptions {
  relayUrl: string;
  orgToken: string;
  key: RelayKey;
  /** 自报显示名，只当展示（协议 §2.2）；缺省主机名 */
  name?: string;
  /** 本机 bridge 的 peer 专用入口，如 http://127.0.0.1:3848；没给则入站一律 local_unreachable */
  localIngress?: string;
  /** 覆盖入站处理（端到端测试的假实例用）；缺省 = 验签后转发到 localIngress */
  onRequest?: InboundHandler;
  fetchImpl?: typeof fetch;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
  /** 只给测试缩短时间：退避起点 / 上限（生产 1 s / 30 s）、心跳间隔（生产 25 s） */
  backoffMs?: { base: number; max: number };
  heartbeatMs?: number;
}

export interface RelayClient {
  readonly fingerprint: string;
  readonly state: RelayState;
  /** 经中继调对方。成功 = 对方 bridge 的 HTTP 响应（哪怕 4xx/5xx）；抛 RelayError = 没拿到响应 */
  request(toFp: string, req: RelayRequest, opts?: { timeoutMs?: number }): Promise<RelayResponse>;
  peers(): RelayPeer[];
  onPresence(cb: (peer: RelayPeer) => void): () => void;
  onStateChange(cb: (state: RelayState, reason?: RelayError) => void): () => void;
  close(): Promise<void>;
}

const RELAY_SUBPROTOCOL = "claudestra-relay.v1";
const RELAY_FROM_HEADER = "x-claudestra-relay-from";
const SIG = { key: "x-claudestra-key", ts: "x-claudestra-ts", sig: "x-claudestra-sig" } as const;
const REPLAY_TTL_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 40_000, ONLINE_WAIT_MS = 10_000, PONG_WAIT_MS = 20_000, FATAL_BACKOFF_MS = 300_000;
/** 不换配置重连也没用的错误（含 replaced：克隆了 STATE_DIR 的两台机器秒级互顶就是抖动） */
const FATAL = new Set(["auth_failed", "org_invalid", "org_mismatch", "fingerprint_conflict", "protocol_version", "replaced"]);
const FATAL_CLOSE = new Set([4401, 4403, 4409, 4429]);
const HOP = new Set([
  "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade",
  "proxy-authorization", "proxy-authenticate", "host", "content-length",
]);

/** 握手签名（协议 §2.2）：nonce、公钥、口令哈希、显示名各占一行 */
function authSignature(key: RelayKey, nonce: string, orgToken: string, name: string): string {
  const orgHash = createHash("sha256").update(orgToken).digest("hex");
  const msg = `claudestra-relay-auth-v1\n${nonce}\n${key.publicKey}\n${orgHash}\n${name}`;
  return sign(null, Buffer.from(msg), key.privateKey).toString("base64url");
}

// ── 入站处理（协议 §4）────────────────────────────────────────────────────────────────

/** 规整后必须落在 /api/v1 下。发起方和接收方都查：入口本身只认 /api/v1，这里是纵深防御 */
function apiPathOk(path: string): boolean {
  try {
    const p = new URL(path, "http://relay.invalid").pathname;
    return path.startsWith("/") && (p === "/api/v1" || p.startsWith("/api/v1/"));
  } catch {
    return false; // 解析不了的 path 不可能是合法的 /api/v1 路径
  }
}

/** 转发到本机前的头处理：去 hop-by-hop / host / content-length / x-forwarded-* / 发起方自带的 relay 头，再盖上 from */
function forwardHeaders(h: Record<string, string>, from: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (HOP.has(key) || key.startsWith("x-forwarded-") || key.startsWith("x-claudestra-relay-")) continue;
    out[key] = v;
  }
  out[RELAY_FROM_HEADER] = from;
  return out;
}

/** 入站帧校验（纯函数）：签名头 ↔ from ↔ canonical ↔ 重放缓存。返回 null = 通过 */
function verifyInbound(req: RelayRequest, from: string, seen: Map<string, number>, now = Date.now()): RelayError | null {
  const key = req.headers[SIG.key], ts = req.headers[SIG.ts], sig = req.headers[SIG.sig];
  if (!key || !ts || !sig) return new RelayError("bad_signature", "peer", "missing signature headers");
  if (!isPublicKey(key) || keyFingerprint(key) !== from) {
    return new RelayError("bad_signature", "peer", "signing key does not match sender");
  }
  const r = verifySigned(key, { method: req.method, path: req.path, ts, sig, body: req.body }, now);
  if (r !== "ok") return new RelayError("bad_signature", "peer", r === "stale" ? "timestamp outside allowed skew" : "signature mismatch");
  // 只管非幂等方法：Ed25519 签名是确定性的，同一秒内两次相同的 GET 签名一样，分不出「重放」和「又问了一次」；GET 重放也没有危害
  if (req.method === "GET" || req.method === "HEAD") return null;
  for (const [s, t] of seen) if (now - t > REPLAY_TTL_MS) seen.delete(s);
  if (seen.has(sig)) return new RelayError("replay", "peer", "signature already seen");
  seen.set(sig, now);
  return null;
}

/** 缺省入站处理：验签 → fetch 本机入口。localIngress 没给一律 local_unreachable（端口没配由 relay-link 启动前兜） */
function localForwarder(o: { localIngress?: string; fetchImpl?: typeof fetch }): InboundHandler {
  const seen = new Map<string, number>();
  const f = o.fetchImpl ?? fetch;
  return async (req, ctx) => {
    const bad = verifyInbound(req, ctx.from, seen);
    if (bad) throw bad;
    if (!o.localIngress) throw new RelayError("local_unreachable", "peer", "no local ingress configured");
    const timeout = AbortSignal.timeout(ctx.timeoutMs);
    let res: Response;
    try {
      res = await f(o.localIngress.replace(/\/+$/, "") + req.path, {
        method: req.method,
        headers: forwardHeaders(req.headers, ctx.from),
        body: req.method === "GET" || req.method === "HEAD" ? undefined : (req.body.slice().buffer as ArrayBuffer),
        signal: AbortSignal.any([ctx.signal, timeout]),
      });
    } catch (e) {
      if (timeout.aborted) throw new RelayError("local_timeout", "peer", `local bridge did not answer within ${ctx.timeoutMs} ms`);
      throw new RelayError("local_unreachable", "peer", (e as Error).message);
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { if (!HOP.has(k)) headers[k] = v; });
    return { status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()) };
  };
}

// ── 连接 ───────────────────────────────────────────────────────────────────────────

const b64 = {
  enc: (u: Uint8Array): string => Buffer.from(u).toString("base64"),
  dec: (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64")),
};
type Frame = Record<string, unknown>;
const lowerHeaders = (h: unknown): Record<string, string> => {
  const src = (h && typeof h === "object" ? h : {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(src).map(([k, v]) => [k.toLowerCase(), String(v)]));
};
interface Waiter { resolve: (r: RelayResponse) => void; reject: (e: RelayError) => void; timer: ReturnType<typeof setTimeout> }

class Client implements RelayClient {
  readonly fingerprint: string;
  state: RelayState = "connecting";
  private ws: WebSocket | null = null;
  private attempt = 0;
  private fatal: RelayError | null = null;
  private closedByUs = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private readonly pending = new Map<string, Waiter>();
  private readonly inbound = new Map<string, AbortController>();
  private readonly peersMap = new Map<string, RelayPeer>();
  private readonly presenceCbs = new Set<(p: RelayPeer) => void>();
  private readonly stateCbs = new Set<(s: RelayState, reason?: RelayError) => void>();
  private onlineWaiters: Array<(ok: boolean) => void> = [];
  private readonly handler: InboundHandler;
  private readonly log: NonNullable<ConnectOptions["log"]>;

  constructor(private readonly o: ConnectOptions) {
    this.fingerprint = keyFingerprint(o.key.publicKey);
    this.handler = o.onRequest ?? localForwarder(o);
    this.log = o.log ?? ((level, msg) => (level === "info" ? console.log : console.error)(`[relay-client] ${msg}`));
    this.dial();
  }

  private dial(): void {
    this.retryTimer = null;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.o.relayUrl.replace(/\/+$/, "") + "/v1/ws", [RELAY_SUBPROTOCOL]);
    } catch (e) {
      return this.scheduleRetry(new RelayError("connection_lost", "client", (e as Error).message)); // 地址本身坏了：按普通断线退避，日志里能看到原因
    }
    this.ws = ws;
    ws.onmessage = (ev) => this.onFrame(String(ev.data));
    ws.onclose = (ev) => this.onClose(ws, ev.code, ev.reason);
    ws.onerror = () => { /* 错误之后必有 close 事件，重连都在 onClose；这里只是别让运行时报「未处理的 error」 */ };
  }

  private setState(s: RelayState, reason?: RelayError): void {
    if (this.state === s) return;
    this.state = s;
    for (const cb of this.stateCbs) cb(s, reason);
  }

  private send(frame: Frame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false; // 在 readyState 检查和 send 之间被关掉了：onClose 会把在途请求全部结掉，这里只需报「没发出去」
    }
  }

  private onFrame(raw: string): void {
    let f: Frame;
    try {
      f = JSON.parse(raw);
    } catch {
      return this.log("warn", "中继发来坏 JSON，忽略"); // 中继是我们自己的实现，坏帧只可能是 bug；不能因为一帧断线
    }
    switch (f.t) {
      case "hello": return void this.send({
        t: "auth", v: 1, key: this.o.key.publicKey, name: this.name(), org: this.o.orgToken,
        sig: authSignature(this.o.key, String(f.nonce), this.o.orgToken, this.name()),
      });
      case "welcome": return this.onWelcome(f);
      case "req": return void this.onReq(f);
      case "res": return this.settle(String(f.id), (w) => w.resolve(this.decodeRes(f.res)));
      case "error": return this.onError(f);
      case "cancel": return this.inbound.get(String(f.id))?.abort();
      case "presence": return this.handlePresence(f.peer as RelayPeer);
      case "peers": return void (Array.isArray(f.peers) && this.replacePeers(f.peers as RelayPeer[]));
      case "ping": return void this.send({ t: "pong", ts: f.ts });
      case "pong": return void (this.pongTimer && clearTimeout(this.pongTimer));
      default: return this.log("warn", `未知帧类型 ${String(f.t)}`);
    }
  }

  private name(): string {
    return (this.o.name ?? hostname()).replace(/[^\p{L}\p{N} ._-]/gu, "_").slice(0, 64) || "claudestra";
  }

  private onWelcome(f: Frame): void {
    this.attempt = 0;
    this.fatal = null;
    this.replacePeers(Array.isArray(f.peers) ? (f.peers as RelayPeer[]) : []);
    this.setState("online");
    for (const w of this.onlineWaiters.splice(0)) w(true);
    const every = this.o.heartbeatMs ?? 25_000;
    this.pingTimer = setInterval(() => {
      this.send({ t: "ping", ts: Date.now() });
      this.pongTimer ??= setTimeout(() => this.ws?.close(4408, "pong timeout"), Math.min(PONG_WAIT_MS, every));
    }, every);
    this.log("info", `已登录中继，指纹 ${this.fingerprint}，同组织 ${this.peersMap.size} 个实例`);
  }

  private onError(f: Frame): void {
    const err = new RelayError(String(f.code), f.origin === "peer" ? "peer" : "relay", typeof f.message === "string" ? f.message : undefined);
    if (typeof f.id === "string") return this.settle(f.id, (w) => w.reject(err));
    if (FATAL.has(err.code)) this.fatal = err;
    this.log(FATAL.has(err.code) ? "error" : "warn", `中继报错 ${err.code}${err.message !== err.code ? `: ${err.message}` : ""}`);
  }

  private handlePresence(p: RelayPeer): void {
    if (!p || typeof p.fp !== "string") return;
    this.peersMap.set(p.fp, p);
    this.presenceCbs.forEach((cb) => cb(p));
  }

  private replacePeers(list: RelayPeer[]): void {
    this.peersMap.clear();
    for (const p of list) if (p && typeof p.fp === "string") this.peersMap.set(p.fp, p);
  }

  private settle(id: string, fn: (w: Waiter) => void): void {
    const w = this.pending.get(id);
    if (!w) return; // 已超时或已被 connection_lost 结掉的请求，迟到的响应没人等
    this.pending.delete(id);
    clearTimeout(w.timer);
    fn(w);
  }

  private decodeRes(r: unknown): RelayResponse {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    return { status: Number(o.status) || 0, headers: lowerHeaders(o.headers), body: b64.dec(String(o.body ?? "")) };
  }

  private onClose(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.ws) return; // 被顶替的旧 socket 晚到的 close：新连接已经在跑
    this.ws = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = this.pongTimer = null;
    const lost = new RelayError("connection_lost", "client", `relay connection closed (${code} ${reason})`);
    for (const w of this.pending.values()) { clearTimeout(w.timer); w.reject(lost); }
    this.pending.clear();
    for (const ac of this.inbound.values()) ac.abort();
    if (this.closedByUs) return this.setState("closed");
    if (!this.fatal && FATAL_CLOSE.has(code)) this.fatal = new RelayError(reason || `close_${code}`, "relay");
    this.scheduleRetry(this.fatal ?? lost);
  }

  private scheduleRetry(reason: RelayError): void {
    const base = this.o.backoffMs?.base ?? 1000, max = this.o.backoffMs?.max ?? 30_000;
    // 致命错误固定 5 分钟；其余 1→30 s 指数退避 ±20% 抖动，中继重启时几百个客户端不能同时撞回来
    const delay = this.fatal ? Math.max(base, FATAL_BACKOFF_MS * (this.o.backoffMs ? base / 1000 : 1)) : Math.min(max, base * 2 ** this.attempt) * (0.8 + Math.random() * 0.4);
    this.attempt++;
    this.setState(this.fatal ? "offline" : "connecting", reason);
    for (const w of this.onlineWaiters.splice(0)) w(!this.fatal);
    this.log(this.fatal ? "error" : "warn", `${reason.code}，${Math.round(delay / 1000)} s 后重连`);
    this.retryTimer = setTimeout(() => this.dial(), delay);
  }

  private waitOnline(): Promise<void> {
    if (this.state === "online") return Promise.resolve();
    if (this.state === "closed") return Promise.reject(new RelayError("closed", "client"));
    if (this.state === "offline") return Promise.reject(this.fatal ?? new RelayError("connection_lost", "client"));
    // 首连或重连中：中继重启的抖动不该让 agent 看到「网络不可达」，等一小会
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(false), ONLINE_WAIT_MS);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.onlineWaiters = this.onlineWaiters.filter((w) => w !== done);
        ok && this.state === "online" ? resolve() : reject(this.fatal ?? new RelayError("connection_lost", "client", "relay not reachable"));
      };
      this.onlineWaiters.push(done);
    });
  }

  async request(to: string, req: RelayRequest, opts: { timeoutMs?: number } = {}): Promise<RelayResponse> {
    if (!apiPathOk(req.path)) throw new RelayError("path_forbidden", "client", req.path);
    await this.waitOnline();
    const id = `r_${Date.now()}_${(this.seq++).toString(36)}`;
    const timeoutMs = Math.max(1000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      // 比中继的期限多 5 s：正常情况下中继的 timeout 错误先到，这个只兜「中继自己没了」
      const timer = setTimeout(() => this.settle(id, (w) => w.reject(new RelayError("timeout", "client", "no answer from relay"))), timeoutMs + 5000);
      this.pending.set(id, { resolve, reject, timer });
      const frame = { t: "req", id, to, timeoutMs, req: { method: req.method.toUpperCase(), path: req.path, headers: req.headers, body: b64.enc(req.body) } };
      if (!this.send(frame)) this.settle(id, (w) => w.reject(new RelayError("connection_lost", "client", "socket not open")));
    });
  }

  private async onReq(f: Frame): Promise<void> {
    const id = String(f.id), from = String(f.from);
    const r = (f.req && typeof f.req === "object" ? f.req : {}) as Record<string, unknown>;
    const req: RelayRequest = { method: String(r.method ?? "GET").toUpperCase(), path: String(r.path ?? ""), headers: lowerHeaders(r.headers), body: b64.dec(String(r.body ?? "")) };
    const ac = new AbortController();
    this.inbound.set(id, ac);
    try {
      if (!apiPathOk(req.path)) throw new RelayError("path_forbidden", "peer", req.path);
      // 本机调用比帧期限少 2 s：自己的超时错误要赶在中继的 timeout 之前送回发起方
      const res = await this.handler(req, { from, signal: ac.signal, timeoutMs: Math.max(1000, (Number(f.timeoutMs) || DEFAULT_TIMEOUT_MS) - 2000) });
      if (ac.signal.aborted) return; // 中继已 cancel：结果没人等，回了也只会得到 unknown_request
      this.send({ t: "res", id, to: from, res: { status: res.status, headers: res.headers, body: b64.enc(res.body) } });
    } catch (e) {
      if (ac.signal.aborted) return; // 中继已 cancel（超时或发起方断线）：没人等这个结果，回了也是 unknown_request
      const err = e instanceof RelayError ? e : new RelayError("local_unreachable", "peer", (e as Error).message);
      this.send({ t: "error", id, to: from, code: err.code, message: err.message });
    } finally {
      this.inbound.delete(id);
    }
  }

  peers = (): RelayPeer[] => [...this.peersMap.values()];
  onPresence = (cb: (p: RelayPeer) => void): (() => void) => (this.presenceCbs.add(cb), () => void this.presenceCbs.delete(cb));
  onStateChange = (cb: (s: RelayState, reason?: RelayError) => void): (() => void) => (this.stateCbs.add(cb), () => void this.stateCbs.delete(cb));

  async close(): Promise<void> {
    this.closedByUs = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const ws = this.ws;
    if (!ws) return this.setState("closed"); // 退避等待中：没有 socket 要关，onClose 早已把在途请求结掉
    await new Promise<void>((resolve) => {
      const off = this.onStateChange((s) => s === "closed" && (off(), resolve()));
      ws.close(1000, "client closed");
    });
  }
}

/** 同步返回、后台连接；重连、心跳、退避全在库内，调用方不用管 */
export function connect(opts: ConnectOptions): RelayClient {
  return new Client(opts);
}
