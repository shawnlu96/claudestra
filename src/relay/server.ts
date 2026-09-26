/**
 * 中继主体（docs/relay/protocol.md）：Bun.serve + WebSocket 上做握手、联系人门控、帧转发、在线状态、心跳判死；HTTP 交给 front.ts。
 * 状态三处：目录（directory.ts，SQLite）、在线连接与联系人（这里，内存）、在途请求（router.ts，内存）。
 * 中继只读信封字段，headers / body 原样搬运、不记日志——日志只有谁、给谁、id、大小、耗时。
 */
import type { Server, ServerWebSocket } from "bun";
import { randomBytes } from "node:crypto";
import {
  asAuth, asCode, asContacts, asData, asEndOrCancel, asPeerError, asReq, asRes, CLOSE, isPublicKey, isRedeemRequest,
  keyFingerprint, LIMITS, NAME_RE, parseFrame, PROTOCOL_VERSION, RELAY_FROM, SLUG_RE, slugify, verifyAuthSignature, type PeerRecord, type ResFrame,
} from "../lib/relay-protocol.js";
import { Directory } from "./directory.js";
import { Front } from "./front.js";
import { KeyedWindows, SlidingWindow } from "./limiter.js";
import { Router, type Pending } from "./router.js";

export type Logger = (level: "info" | "warn" | "error", msg: string) => void;
type Limits = Record<keyof typeof LIMITS, number>; // 协议默认值可按项覆盖（测试把超时调短）

export interface RelayOptions {
  /** 公网主机名：front 按它切子域名 */
  base: string;
  port?: number;
  hostname?: string;
  /** SQLite 路径；测试用 ":memory:" */
  db?: string;
  /** 反代之后才开：用 X-Forwarded-* 当客户端地址与主机名。直接对外时开了等于限流可绕 */
  trustProxy?: boolean;
  version?: string;
  commit?: string;
  limits?: Partial<Limits>;
  /** 隧道请求等响应头的时长（浏览器那边的 API 调用可能长挂） */
  frontHeadTimeoutMs?: number;
  sweepMs?: number;
  touchEveryMs?: number;
  log?: Logger;
}

export interface ConnData {
  ip: string;
  openedAt: number;
  lastFrameAt: number;
  lastTouch: number;
  /** 发过 hello、还没收到 auth 时非空；auth 一到就清，成败都不再接受第二次（nonce 一次性） */
  nonce: string | null;
  fp: string | null;
  key: string | null;
  slug: string;
  name: string;
  contacts: Set<string>;
  reqWindow: SlidingWindow;
  badFrames: number;
}
export type Conn = ServerWebSocket<ConnData>;
type Obj = Record<string, unknown>;

export interface Relay {
  port: number;
  directory: Directory;
  online(): string[];
  dropConnection(fp: string, code?: number, reason?: string): boolean; // 测试用：模拟中继重启 / 网络抖动
  stop(): void;
}
const errorFrame = (code: string, message?: string, id?: string) => ({ t: "error", ...(id ? { id } : {}), code, ...(message ? { message } : {}), origin: "relay" });

class RelayServer implements Relay {
  readonly directory: Directory;
  readonly port: number;
  private readonly lim: Limits;
  private readonly log: Logger;
  private readonly conns = new Set<Conn>();
  private readonly onlineMap = new Map<string, Conn>();
  private readonly router: Router<Conn>;
  private readonly front: Front;
  private readonly authWindows: KeyedWindows;
  private readonly redeemWindows: KeyedWindows;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private readonly server: Server<ConnData>;
  private readonly touchEveryMs: number;

  constructor(private readonly opts: RelayOptions) {
    this.lim = { ...LIMITS, ...opts.limits };
    this.log = opts.log ?? ((level, msg) => (level === "info" ? console.log : console.error)(`[relay] ${msg}`));
    this.directory = new Directory(opts.db ?? ":memory:");
    this.router = new Router<Conn>({ streamIdleMs: this.lim.streamIdleMs, streamMaxMs: this.lim.streamMaxMs });
    this.authWindows = new KeyedWindows(this.lim.authPerIpPerMinute);
    this.redeemWindows = new KeyedWindows(this.lim.redeemPerMinute);
    this.touchEveryMs = opts.touchEveryMs ?? 60_000;
    this.front = new Front({
      base: opts.base, trustProxy: opts.trustProxy ?? false, version: opts.version ?? "dev", commit: opts.commit,
      headTimeoutMs: opts.frontHeadTimeoutMs ?? 120_000, maxChunkBytes: this.lim.maxChunkBytes,
      online: () => this.onlineMap.size, pending: () => this.router.size, router: this.router,
      send: (c, f) => this.send(c, f), lookupCode: (code) => this.directory.lookupCode(code),
      bySlug: (slug) => {
        const record = this.directory.bySlug(slug);
        return { record, conn: record ? this.onlineMap.get(record.fp) ?? null : null };
      },
      upgrade: (req, srv, ip) => this.upgrade(req, srv, ip), log: this.log,
    });
    // 定时扫 auth 超时、心跳判死、last_seen 落盘。不用 Bun 的 idleTimeout 是为了关闭码可控（4408）
    this.sweepTimer = setInterval(() => this.sweep(), opts.sweepMs ?? 5_000);
    this.server = Bun.serve<ConnData>({
      port: opts.port ?? 8787,
      hostname: opts.hostname ?? "127.0.0.1",
      fetch: (req, srv) => this.front.handle(req, srv),
      websocket: {
        // 硬上限交给 Bun（超过关 1009）；协议上限在 onMessage 里自己判，才能回 frame_too_large + 4413
        maxPayloadLength: this.lim.maxFrameBytes * 2,
        idleTimeout: 120,
        open: (ws) => this.onOpen(ws),
        message: (ws, msg) => this.onMessage(ws, msg),
        close: (ws, code, reason) => this.onClose(ws, code, reason),
      },
    });
    this.port = this.server.port ?? opts.port ?? 8787;
    this.log("info", `中继监听 ${opts.hostname ?? "127.0.0.1"}:${this.port} base=${opts.base} db=${opts.db ?? ":memory:"}`);
  }

  online = (): string[] => [...this.onlineMap.keys()];

  dropConnection(fp: string, code: number = CLOSE.RESTART, reason = "dropped"): boolean {
    const ws = this.onlineMap.get(fp);
    ws?.close(code, reason);
    return !!ws;
  }

  stop(): void {
    clearInterval(this.sweepTimer);
    for (const ws of this.conns) ws.close(CLOSE.RESTART, "relay stopping");
    this.router.clear();
    this.server.stop(true);
    this.directory.close();
  }

  // ── 收发工具 ──────────────────────────────────────────────────────────

  private send(ws: Conn, frame: object): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // 连接正在关闭：close 回调会把它的 pending 清掉并通知另一头，这一帧没有别的去处，丢掉是安全的
    }
  }

  private reject(ws: Conn, code: string, closeCode: number, message?: string): void {
    this.send(ws, errorFrame(code, message));
    ws.close(closeCode, code);
  }

  private upgrade(req: Request, srv: Server<ConnData>, ip: string): Response | undefined {
    const now = Date.now();
    const data: ConnData = {
      ip, openedAt: now, lastFrameAt: now, lastTouch: 0, nonce: null, fp: null, key: null, slug: "", name: "",
      contacts: new Set(), reqWindow: new SlidingWindow(this.lim.reqPerMinute), badFrames: 0,
    };
    return srv.upgrade(req, { data, headers: { "Sec-WebSocket-Protocol": "claudestra-relay.v2" } }) ? undefined : new Response("upgrade failed", { status: 400 });
  }

  // ── 连接生命周期 ───────────────────────────────────────────────────────

  private onOpen(ws: Conn): void {
    this.conns.add(ws);
    if (!this.authWindows.tryAcquire(ws.data.ip)) return this.reject(ws, "rate_limited", CLOSE.RATE, "too many handshakes from this address");
    ws.data.nonce = randomBytes(32).toString("base64url");
    this.send(ws, {
      t: "hello", v: PROTOCOL_VERSION, nonce: ws.data.nonce, ts: Math.floor(Date.now() / 1000),
      limits: { maxFrameBytes: this.lim.maxFrameBytes, maxChunkBytes: this.lim.maxChunkBytes, maxReqTimeoutMs: this.lim.maxReqTimeoutMs, heartbeatMs: this.lim.heartbeatMs },
    });
  }

  private onMessage(ws: Conn, msg: string | Buffer): void {
    ws.data.lastFrameAt = Date.now();
    if (typeof msg !== "string") return this.reject(ws, "frame_invalid", CLOSE.PROTOCOL, "binary frames are not allowed");
    const bytes = Buffer.byteLength(msg);
    if (bytes > this.lim.maxFrameBytes) return this.reject(ws, "frame_too_large", CLOSE.TOO_LARGE, `frame exceeds ${this.lim.maxFrameBytes} bytes`);
    const f = parseFrame(msg);
    if (!f) {
      if (++ws.data.badFrames >= 3) return this.reject(ws, "frame_invalid", CLOSE.PROTOCOL, "too many malformed frames");
      return this.send(ws, errorFrame("frame_invalid", "not a JSON object with t"));
    }
    if (f.t === "ping") return this.send(ws, { t: "pong", ts: f.ts ?? Date.now() });
    if (f.t === "pong") return;
    if (!ws.data.fp) return f.t === "auth" ? this.onAuth(ws, f) : this.reject(ws, "not_authenticated", CLOSE.PROTOCOL, "auth first");
    const id = typeof f.id === "string" ? f.id : undefined;
    switch (f.t) {
      case "req": return this.onReq(ws, f, bytes);
      case "res": return this.onRes(ws, f, bytes);
      case "data": return this.onData(ws, f);
      case "end": case "cancel": return this.onEndOrCancel(ws, f);
      case "error": return this.onPeerError(ws, f);
      case "contacts": return this.onContacts(ws, f);
      case "code": return this.onCode(ws, f);
      case "auth": return this.send(ws, errorFrame("frame_invalid", "already authenticated"));
      default: return this.send(ws, errorFrame("frame_invalid", `unknown frame type ${f.t}`, id));
    }
  }

  private onClose(ws: Conn, code: number, reason: string): void {
    this.conns.delete(ws);
    for (const p of this.router.dropConn(ws)) {
      if (p.toConn === ws) this.failInitiator(p, "peer_disconnected", `${p.to} disconnected`);
      else if (p.fromConn) this.send(p.toConn, { t: "cancel", id: p.id, from: p.from });
    }
    const fp = ws.data.fp;
    if (!fp) return this.log("info", `未认证连接关闭 ip=${ws.data.ip} code=${code}`);
    if (this.onlineMap.get(fp) !== ws) return; // 被顶掉的旧连接：新连接已接管这个指纹，目录与广播都不该动
    this.onlineMap.delete(fp);
    const now = new Date().toISOString();
    this.directory.touch([fp], now);
    this.broadcastPresence(ws, false, now);
    this.log("info", `${fp} 下线 code=${code} ${reason}`);
  }

  private sweep(): void {
    const now = Date.now();
    const touch: string[] = [];
    for (const ws of this.conns) {
      if (!ws.data.fp && now - ws.data.openedAt > this.lim.authTimeoutMs) this.reject(ws, "auth_timeout", CLOSE.TIMEOUT, "no auth within deadline");
      else if (now - ws.data.lastFrameAt > this.lim.idleTimeoutMs) this.reject(ws, "heartbeat_timeout", CLOSE.TIMEOUT, "no frame within idle window");
      else if (ws.data.fp && now - ws.data.lastTouch >= this.touchEveryMs) {
        ws.data.lastTouch = now;
        touch.push(ws.data.fp);
      }
    }
    this.directory.touch(touch);
    this.directory.sweepCodes(now);
    this.authWindows.sweep(now);
    this.redeemWindows.sweep(now);
  }

  // ── 握手与目录 ─────────────────────────────────────────────────────────

  /** §2.3 的校验顺序；任何一步失败都发 error 再关，客户端靠 code 决定退避多久 */
  private onAuth(ws: Conn, raw: Obj): void {
    const f = asAuth(raw);
    const nonce = ws.data.nonce;
    ws.data.nonce = null;
    if (!f) return this.reject(ws, "frame_invalid", CLOSE.PROTOCOL, "auth frame malformed");
    if (f.v !== PROTOCOL_VERSION) return this.reject(ws, "protocol_version", CLOSE.PROTOCOL, `expected v${PROTOCOL_VERSION}`);
    if (!nonce || Date.now() - ws.data.openedAt > this.lim.nonceTtlMs) return this.reject(ws, "nonce_expired", CLOSE.AUTH);
    if (!isPublicKey(f.key) || !NAME_RE.test(f.name) || !SLUG_RE.test(f.slug)) return this.reject(ws, "frame_invalid", CLOSE.PROTOCOL, "bad key, name or slug");
    if (!verifyAuthSignature(f.key, nonce, f.name, f.slug, f.sig)) return this.reject(ws, "auth_failed", CLOSE.AUTH);
    const fp = keyFingerprint(f.key);
    const reg = this.directory.register(fp, f.key, slugify(f.slug), f.name);
    if (reg === "fingerprint_conflict") return this.reject(ws, reg, CLOSE.DIRECTORY);
    const prev = this.onlineMap.get(fp);
    if (prev) {
      // 实例重启时旧 socket 往往还没被判死；不顶掉它新连接就永远进不来。克隆过 STATE_DIR 的两台机器会互顶，靠这条日志发现
      this.log("warn", `${fp} 新连接顶掉旧连接 ${prev.data.ip} → ${ws.data.ip}`);
      this.reject(prev, "replaced", CLOSE.REPLACED);
    }
    Object.assign(ws.data, { fp, key: f.key, slug: reg.slug, name: f.name, lastTouch: Date.now() });
    this.onlineMap.set(fp, ws);
    this.send(ws, { t: "welcome", v: PROTOCOL_VERSION, fp, slug: reg.slug, name: f.name, base: this.opts.base });
    this.log("info", `${fp}「${f.name}」上线 slug=${reg.slug} ip=${ws.data.ip}`);
  }

  private mutual(a: Conn, fp: string): Conn | null {
    const other = this.onlineMap.get(fp);
    return other && a.data.contacts.has(fp) && other.data.contacts.has(a.data.fp!) ? other : null;
  }

  private record(ws: Conn, fp: string, rec: { slug: string; name: string; lastSeen: string }): PeerRecord {
    const other = this.mutual(ws, fp);
    return { fp, slug: rec.slug, name: rec.name, online: !!other, lastSeen: other ? new Date().toISOString() : rec.lastSeen, mutual: !!other };
  }

  /** 联系人清单：全量替换，回 peers；把自己的在线状态推给刚变成双向的联系人（§4） */
  private onContacts(ws: Conn, raw: Obj): void {
    const f = asContacts(raw);
    if (!f) return this.send(ws, errorFrame("frame_invalid", "contacts frame malformed"));
    ws.data.contacts = new Set(f.fps.filter((fp) => fp !== ws.data.fp));
    const peers = this.directory.many([...ws.data.contacts]).map((r) => this.record(ws, r.fp, r));
    this.send(ws, { t: "peers", peers });
    this.broadcastPresence(ws, true, new Date().toISOString());
  }

  private broadcastPresence(ws: Conn, online: boolean, lastSeen: string): void {
    const peer = { fp: ws.data.fp, slug: ws.data.slug, name: ws.data.name, online, lastSeen };
    for (const fp of ws.data.contacts) {
      const other = this.mutual(ws, fp);
      if (other) this.send(other, { t: "presence", peer });
    }
  }

  private onCode(ws: Conn, raw: Obj): void {
    const f = asCode(raw);
    if (!f) return this.send(ws, errorFrame("frame_invalid", "code frame malformed"));
    if (f.op === "del") return void this.directory.delCode(f.code, ws.data.fp!);
    const exp = Math.min(f.exp! * 1000, Date.now() + this.lim.codeTtlMs + 5 * 60_000);
    if (!this.directory.putCode(f.code, ws.data.fp!, exp)) this.send(ws, errorFrame("rate_limited", `at most ${this.lim.maxCodesPerInstance} pairing codes, or code taken`));
  }

  // ── 请求 / 响应 / 流 ───────────────────────────────────────────────────

  private onReq(ws: Conn, raw: Obj, bytes: number): void {
    const f = asReq(raw);
    const from = ws.data.fp!;
    if (!f || !f.to) return this.send(ws, errorFrame("frame_invalid", "req frame malformed or missing to", typeof raw.id === "string" ? raw.id : undefined));
    if (!ws.data.reqWindow.tryAcquire()) return this.send(ws, errorFrame("rate_limited", `${this.lim.reqPerMinute} req/min`, f.id));
    if (this.router.inflightOf(ws) >= this.lim.maxInflight) return this.send(ws, errorFrame("rate_limited", `${this.lim.maxInflight} inflight`, f.id));
    if (this.router.has(from, f.id)) return this.send(ws, errorFrame("duplicate_id", undefined, f.id));
    const target = this.onlineMap.get(f.to);
    const listed = target?.data.contacts.has(from) ?? false;
    if (!listed) {
      // 没被列为联系人只剩兑换邀请这一条敲门路径，且限流；目标不在线也一律 peer_unknown，不泄露目录
      if (!target || !isRedeemRequest(f.method, f.path)) return this.send(ws, errorFrame("peer_unknown", `${f.to} is not reachable for you`, f.id));
      if (!this.redeemWindows.tryAcquire(from)) return this.send(ws, errorFrame("rate_limited", `${this.lim.redeemPerMinute} redeem/min`, f.id));
    }
    if (!target) return this.send(ws, errorFrame("peer_offline", `${f.to} not connected`, f.id));
    const timeoutMs = Math.min(this.lim.maxReqTimeoutMs, Math.max(1000, f.timeoutMs ?? this.lim.defaultReqTimeoutMs));
    this.router.add({ id: f.id, from, to: f.to, fromConn: ws, toConn: target }, timeoutMs, {
      onTimeout: (p) => {
        this.failInitiator(p, "timeout", `no response within ${timeoutMs} ms`);
        this.send(p.toConn, { t: "cancel", id: p.id, from: p.from });
      },
      onStreamTimeout: (p, why) => {
        this.failInitiator(p, why, "stream stalled");
        this.send(p.toConn, { t: "cancel", id: p.id, from: p.from });
      },
    });
    const { to: _to, ...rest } = f;
    this.send(target, { ...rest, from, timeoutMs });
    this.log("info", `req ${from} → ${f.to} id=${f.id} ${f.method} ${f.path.split("?")[0].slice(0, 60)} ${bytes}B timeout=${timeoutMs}`);
  }

  /** 发起方那头：peer 是另一台实例，隧道是 front 的 waiter */
  private failInitiator(p: Pending<Conn>, code: string, message?: string): void {
    if (p.fromConn) this.send(p.fromConn, errorFrame(code, message, p.id));
    else p.waiter?.fail(code, message);
  }

  /** 一帧对应哪条 pending、往哪边走：发起方发的（请求正文）键 `${自己}|${id}` 往接收方转；接收方发的（响应）键 `${to}|${id}`（隧道 to 省略 → relay）往发起方转 */
  private resolve(ws: Conn, f: { id: string; to?: string }): { p: Pending<Conn>; dir: "toReceiver" | "toInitiator" } | null {
    const fwd = f.to ? this.router.get(ws.data.fp!, f.id) : null;
    if (fwd && fwd.to === f.to && fwd.fromConn === ws) return { p: fwd, dir: "toReceiver" };
    const back = this.router.get(f.to ?? RELAY_FROM, f.id);
    if (back && back.toConn === ws) return { p: back, dir: "toInitiator" };
    return null;
  }

  private relay(p: Pending<Conn>, dir: "toReceiver" | "toInitiator", frame: Obj): void {
    const { to: _to, ...rest } = frame;
    if (dir === "toReceiver") return this.send(p.toConn, { ...rest, from: p.from });
    if (p.fromConn) return this.send(p.fromConn, { ...rest, from: p.to });
    // 隧道：翻译成 waiter 回调
    if (frame.t === "data") p.waiter?.data(new Uint8Array(Buffer.from(String(frame.b64), "base64")));
    else if (frame.t === "end") p.waiter?.end();
    else if (frame.t === "cancel") p.waiter?.fail("cancelled", "peer cancelled");
  }

  private onRes(ws: Conn, raw: Obj, bytes: number): void {
    const f = asRes(raw);
    if (!f) return this.send(ws, errorFrame("frame_invalid", "res frame malformed", typeof raw.id === "string" ? raw.id : undefined));
    const r = this.resolve(ws, f);
    if (!r || r.dir !== "toInitiator") return this.send(ws, errorFrame("unknown_request", "no pending request (timed out or requester gone)", f.id));
    const { p } = r;
    const { to: _to, ...rest } = f;
    if (p.fromConn) this.send(p.fromConn, { ...rest, from: p.to });
    else p.waiter?.head(f);
    if (f.more) this.router.headArrived(p);
    else this.router.remove(p);
    this.log("info", `res ${p.to} → ${p.from} id=${p.id} ${f.status} ${bytes}B ${Date.now() - p.startedAt}ms${f.more ? " stream" : ""}`);
  }

  private onData(ws: Conn, raw: Obj): void {
    const f = asData(raw);
    if (!f) return this.send(ws, errorFrame("frame_invalid", "data frame malformed", typeof raw.id === "string" ? raw.id : undefined));
    const r = this.resolve(ws, f);
    if (!r) return this.send(ws, errorFrame("unknown_request", undefined, f.id));
    this.router.activity(r.p);
    this.relay(r.p, r.dir, f as unknown as Obj);
  }

  private onEndOrCancel(ws: Conn, raw: Obj): void {
    const f = asEndOrCancel(raw);
    if (!f) return this.send(ws, errorFrame("frame_invalid", `${String(raw.t)} frame malformed`, typeof raw.id === "string" ? raw.id : undefined));
    const r = this.resolve(ws, f);
    if (!r) return this.send(ws, errorFrame("unknown_request", undefined, f.id));
    this.relay(r.p, r.dir, f as unknown as Obj);
    // 响应流收尾、或任一方取消 → 这条请求结束；请求正文的 end 不结束（响应还没来）
    if (f.t === "cancel" || (r.dir === "toInitiator" && r.p.state === "stream")) this.router.remove(r.p);
    if (f.t === "cancel") this.log("info", `cancel ${ws.data.fp} id=${f.id}`);
  }

  private onPeerError(ws: Conn, raw: Obj): void {
    const f = asPeerError(raw);
    if (!f) return this.log("warn", `${ws.data.fp} 发来没有 id 的 error 帧: ${String(raw.code)}`);
    const r = this.resolve(ws, f);
    if (!r || r.dir !== "toInitiator") return this.send(ws, errorFrame("unknown_request", undefined, f.id));
    if (r.p.fromConn) this.send(r.p.fromConn, { t: "error", id: f.id, from: r.p.to, code: f.code, ...(f.message ? { message: f.message } : {}), origin: "peer" });
    else r.p.waiter?.fail(f.code, f.message);
    this.router.remove(r.p);
    this.log("info", `err ${r.p.to} → ${r.p.from} id=${f.id} ${f.code}`);
  }
}

export function createRelay(opts: RelayOptions): Relay {
  return new RelayServer(opts);
}
