/**
 * 中继客户端（docs/relay/protocol.md）：一条出站 WebSocket 到中继，握手（hello → auth → welcome）、心跳、
 * 退避重连、联系人与短码的登记；请求 / 响应帧的收发分在 relay-client-outbound.ts（我发出去的）与
 * relay-client-inbound.ts（送进来的），这里只做分发。不读 .env、不落盘、不签业务请求——配置与签名头由
 * bridge/relay-link.ts 传进来；协议常量与帧校验只从 relay-protocol.ts 取。
 */
import { randomBytes } from "node:crypto";
import type { InstanceKey } from "./instance-key.js";
import {
  FATAL_CODES, LIMITS, PROTOCOL_VERSION, RELAY_FROM, SUBPROTOCOL, asData, asEndOrCancel, asPushAck, asReq, asRes, authSignature, parseFrame,
  relayWsEndpoint, type ErrorFrame, type PeerRecord, type RelayPushCapabilities,
} from "./relay-protocol.js";
import { InboundRouter, type Logger } from "./relay-client-inbound.js";
import { OutboundTable, type RequestOptions } from "./relay-client-outbound.js";
import { PushTable } from "./relay-client-push.js";
import { DEFAULT_LIVENESS, RelayLiveness, type LivenessOptions } from "./relay-liveness.js";
import { RelayTraffic } from "./relay-traffic.js";
import { remoteCode } from "./remote-text.js";
import { RelayError, type InboundHandler, type PushAck, type PushRequest, type RelayInfo, type RelayRequest, type RelayResponse, type RelayState } from "./relay-client-types.js";

export { RelayError };
export type { InboundHandler, InboundResponse, PushAck, PushRequest, RelayInfo, RelayRequest, RelayResponse, RelayState } from "./relay-client-types.js";

/** 测试把这些调小；生产用 LIMITS 的默认值 */
export interface RelayTiming {
  heartbeatMs: number;
  pongTimeoutMs: number;
  /** 重连退避序列（秒级默认 1,2,4,8,16,30），超出用最后一项 */
  backoffMs: number[];
  /** 连接稳定这么久之后退避计数归零 */
  stableMs: number;
  fatalRetryMs: number;
  /** 等响应头时在中继超时之外再多等的余量 */
  headGraceMs: number;
  /** push 帧等 push-ack 的时长（中继投递给推送服务本身有 10 s 超时） */
  pushTimeoutMs: number;
}

export interface ConnectOptions {
  relayUrl: string;
  key: InstanceKey;
  name: string;
  slug: string;
  onInbound?: InboundHandler;
  onPresence?: (peer: PeerRecord) => void;
  onWelcome?: (info: RelayInfo) => void;
  log?: Logger;
  timing?: Partial<RelayTiming>;
  liveness?: LivenessOptions;
}

const DEFAULT_TIMING: RelayTiming = {
  heartbeatMs: LIMITS.heartbeatMs,
  pongTimeoutMs: LIMITS.pongTimeoutMs,
  backoffMs: [1000, 2000, 4000, 8000, 16_000, 30_000],
  stableMs: 60_000,
  fatalRetryMs: LIMITS.fatalRetryMs,
  headGraceMs: 5_000,
  pushTimeoutMs: 15_000,
};

const jitter = (ms: number): number => Math.round(ms * (0.8 + Math.random() * 0.4));
const rand = (n: number): Uint8Array => new Uint8Array(randomBytes(n));

export class RelayClient {
  private ws: WebSocket | null = null;
  private _state: RelayState = "connecting";
  private fp: string | null = null;
  private slug: string | null = null;
  private base: string | null = null;
  private pushCaps: RelayPushCapabilities | null = null;
  private contacts: string[] | null = null;
  private readonly codes = new Map<string, number>();
  private readonly peersMap = new Map<string, PeerRecord>();
  private attempts = 0;
  private onlineSince = 0;
  private retryAt: number | null = null;
  private lastError: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly timing: RelayTiming;
  private readonly log: Logger;
  private readonly outbound: OutboundTable;
  private readonly inbound: InboundRouter;
  private readonly pushes: PushTable;
  private readonly liveness: RelayLiveness;
  private readonly traffic = new RelayTraffic();

  constructor(private readonly o: ConnectOptions) {
    this.timing = { ...DEFAULT_TIMING, ...o.timing };
    this.liveness = new RelayLiveness(o.liveness ?? DEFAULT_LIVENESS);
    this.log = o.log ?? ((level, msg) => (level === "info" ? console.log : console.error)(`[relay] ${msg}`));
    const send = (f: object) => this.send(f);
    this.outbound = new OutboundTable(send, rand, LIMITS.maxChunkBytes, this.timing.headGraceMs);
    this.inbound = new InboundRouter(send, o.onInbound, this.log, LIMITS.maxChunkBytes, this.traffic);
    this.pushes = new PushTable(send, rand, this.timing.pushTimeoutMs);
    this.open();
  }

  get state(): RelayState {
    return this._state;
  }

  info(): RelayInfo & { retryAt: number | null; lastError: string | null } {
    return {
      state: this._state, connected: this._state === "online", fp: this.fp, slug: this.slug, base: this.base, push: this.pushCaps,
      relayUrl: this.o.relayUrl, retryAt: this.retryAt, lastError: this.lastError,
    };
  }

  peers(): PeerRecord[] {
    return [...this.peersMap.values()];
  }

  /** 全量替换联系人；在线就立刻发，否则 welcome 后补发 */
  setContacts(fps: string[]): void {
    const next = [...new Set(fps)].sort();
    if (this.contacts && next.length === this.contacts.length && next.every((v, i) => v === this.contacts![i])) return;
    this.contacts = next;
    if (this._state === "online") this.send({ t: "contacts", fps: next });
  }

  putCode(code: string, exp: number): void {
    this.codes.set(code, exp);
    if (this._state === "online") this.send({ t: "code", op: "put", code, exp });
  }

  delCode(code: string): void {
    this.codes.delete(code);
    if (this._state === "online") this.send({ t: "code", op: "del", code });
  }

  request(to: string, req: RelayRequest, opts: RequestOptions = {}): Promise<RelayResponse> {
    if (this._state !== "online") return Promise.reject(new RelayError("connection_lost", "client", `relay not connected (${this._state}${this.lastError ? `: ${this.lastError}` : ""})`));
    return this.outbound.request(to, req, opts);
  }

  /** 请中继投递一条通知（§3.5）；没连上直接拒，调用方退回直发 */
  push(req: PushRequest): Promise<PushAck> {
    if (this._state !== "online") return Promise.reject(new RelayError("connection_lost", "client", `relay not connected (${this._state})`));
    return this.pushes.push(req);
  }

  /** 主动关闭：不再重连 */
  close(): void {
    this._state = "closed";
    this.clearTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws?.close(1000, "client closing");
    this.ws = null;
    this.outbound.rejectAll(new RelayError("closed", "client", "client closed"));
    this.pushes.rejectAll(new RelayError("closed", "client", "client closed"));
    this.inbound.abortAll();
  }

  // ── 连接生命周期 ─────────────────────────────────────────────────────

  private open(): void {
    if (this._state === "closed") return;
    this._state = "connecting";
    this.retryAt = null;
    let ws: WebSocket;
    try {
      ws = new WebSocket(relayWsEndpoint(this.o.relayUrl), [SUBPROTOCOL]);
    } catch (e) {
      this.lastError = `bad relay url: ${(e as Error).message}`;
      return this.scheduleReconnect(false);
    }
    this.ws = ws;
    ws.onmessage = (ev) => this.onMessage(ws, typeof ev.data === "string" ? ev.data : null);
    ws.onclose = (ev) => this.onClose(ws, ev.code, ev.reason);
    ws.onerror = () => {
      // 错误细节 Bun 不给；close 事件紧随其后，重连逻辑在那里
      if (this.ws === ws) this.lastError = this.lastError ?? "socket error";
    };
  }

  private send(frame: object): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      const raw = JSON.stringify(frame);
      ws.send(raw);
      this.liveness.onSend(raw.length);
      this.traffic.onWire(raw.length);
      return true;
    } catch (e) {
      this.log("warn", `发帧失败（连接正在关闭，close 回调会收尾）: ${(e as Error).message}`);
      return false;
    }
  }

  private onClose(ws: WebSocket, code: number, reason: string): void {
    if (this.ws !== ws) return; // 旧连接的收尾：新连接已经接管
    this.ws = null;
    this.clearTimers();
    const fatal = FATAL_CODES.has(this.lastError ?? "");
    const wasOnline = this._state === "online";
    if (this._state !== "closed") this._state = "offline";
    const lost = new RelayError("connection_lost", "client", `relay connection closed (${code} ${reason || this.lastError || ""})`.trim());
    this.outbound.rejectAll(lost);
    this.pushes.rejectAll(lost);
    this.inbound.abortAll();
    this.logTraffic(this.traffic.flush());
    if (wasOnline) this.log("warn", `中继连接断开 code=${code} ${reason}${this.lastError && this.lastError !== reason ? `（${this.lastError}）` : ""}`);
    this.scheduleReconnect(fatal);
  }

  private scheduleReconnect(fatal: boolean): void {
    if (this._state === "closed" || this.reconnectTimer) return;
    if (this.onlineSince && Date.now() - this.onlineSince >= this.timing.stableMs) this.attempts = 0;
    this.onlineSince = 0;
    const seq = this.timing.backoffMs;
    const delay = fatal ? this.timing.fatalRetryMs : jitter(seq[Math.min(this.attempts, seq.length - 1)]);
    this.attempts++;
    this.retryAt = Date.now() + delay;
    this.log("info", `${Math.round(delay / 1000)} 秒后重连中继${fatal ? `（${this.lastError}，改配置或等管理员处理）` : ""}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private clearTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.heartbeat = null;
    this.pongTimer = null;
  }

  private startHeartbeat(): void {
    this.clearTimers();
    this.liveness.reset();
    this.heartbeat = setInterval(() => {
      this.logTraffic(this.traffic.tick());
      this.liveness.onPing();
      this.send({ t: "ping", ts: Date.now() });
      if (this.pongTimer) return;
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        const v = this.liveness.onPongTimeout();
        if (!v.dead) return this.log("info", `中继心跳 pong 迟到，疑似排在上行数据后面，顺延（${v.reason}）`);
        this.lastError = `pong timeout (${v.reason})`;
        this.log("warn", `中继心跳无应答，断开重连（${v.reason}）`);
        this.ws?.close(4408, "pong timeout");
      }, this.timing.pongTimeoutMs);
    }, this.timing.heartbeatMs);
  }

  private logTraffic(line: string | null): void {
    if (line) this.log("info", line);
  }

  // ── 帧分发 ─────────────────────────────────────────────────────────────

  private onMessage(ws: WebSocket, raw: string | null): void {
    if (this.ws !== ws) return;
    const f = raw === null ? null : parseFrame(raw);
    if (f && f.t !== "pong") this.liveness.onInbound();
    if (!f) return this.log("warn", "中继发来无法解析的帧，忽略");
    const from = typeof f.from === "string" ? f.from : undefined;
    switch (f.t) {
      case "hello": return this.onHello(f);
      case "welcome": return this.onWelcome(f);
      case "ping": return void this.send({ t: "pong", ts: f.ts });
      case "pong": {
        this.liveness.onPong();
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = null;
        return;
      }
      case "peers": {
        if (!Array.isArray(f.peers)) return;
        this.peersMap.clear();
        for (const p of f.peers as PeerRecord[]) if (p?.fp) this.peersMap.set(p.fp, p);
        return;
      }
      case "presence": {
        const p = f.peer as PeerRecord | undefined;
        if (!p?.fp) return;
        this.peersMap.set(p.fp, { ...(this.peersMap.get(p.fp) ?? {}), ...p });
        return void this.o.onPresence?.(p);
      }
      case "req": {
        const r = asReq(f);
        return r ? this.inbound.onReq(r) : this.log("warn", "req 帧形状不对，忽略");
      }
      case "res": {
        const r = asRes(f);
        if (r && !this.outbound.onRes(r)) this.log("warn", `res 对不上任何在途请求 id=${r.id}`);
        return;
      }
      case "data": {
        const d = asData(f);
        if (!d) return;
        if (this.outbound.owns(d.id, from)) this.outbound.onData(d);
        else if (!this.inbound.onData(from ?? RELAY_FROM, d)) this.log("warn", `data 对不上任何请求 id=${d.id}`);
        return;
      }
      case "end":
      case "cancel": return this.onEndOrCancel(f, from);
      case "push-ack": {
        const a = asPushAck(f);
        if (a && !this.pushes.onAck(a)) this.log("warn", `push-ack 对不上任何在途推送 id=${a.id}`);
        return;
      }
      case "error": return this.onError(f as unknown as ErrorFrame, from);
      default: return this.log("warn", `未知帧类型 ${String(f.t)}`);
    }
  }

  private onEndOrCancel(f: Record<string, unknown>, from: string | undefined): void {
    const e = asEndOrCancel(f);
    if (!e) return;
    if (e.t === "end") {
      if (this.outbound.owns(e.id, from)) this.outbound.onEnd(e);
      else this.inbound.onEnd(from ?? RELAY_FROM, e);
      return;
    }
    if (!this.inbound.onCancel(from ?? RELAY_FROM, e.id)) this.outbound.onCancel(e.id);
  }

  private onHello(f: Record<string, unknown>): void {
    if (f.v !== PROTOCOL_VERSION) {
      this.lastError = "protocol_version";
      return void this.ws?.close(4400, "protocol version");
    }
    const ts = typeof f.ts === "number" ? f.ts : null;
    if (ts !== null && Math.abs(Date.now() / 1000 - ts) > 300) {
      this.log("warn", `本机时钟与中继相差超过 300 秒（${Math.round(Date.now() / 1000 - ts)} s），签名请求会被对方判过期`);
    }
    const sig = authSignature(this.o.key.privateKey, String(f.nonce), this.o.key.publicKey, this.o.name, this.o.slug);
    this.send({ t: "auth", v: PROTOCOL_VERSION, key: this.o.key.publicKey, name: this.o.name, slug: this.o.slug, sig });
  }

  private onWelcome(f: Record<string, unknown>): void {
    this.fp = typeof f.fp === "string" ? f.fp : null;
    this.slug = typeof f.slug === "string" ? f.slug : null;
    this.base = typeof f.base === "string" ? f.base : null;
    const push = f.push as Partial<RelayPushCapabilities> | undefined;
    this.pushCaps = push && typeof push === "object" ? { ...(typeof push.vapidPublicKey === "string" ? { vapidPublicKey: push.vapidPublicKey } : {}), apns: push.apns === true } : null;
    this._state = "online";
    this.lastError = null;
    this.onlineSince = Date.now();
    this.startHeartbeat();
    if (this.contacts) this.send({ t: "contacts", fps: this.contacts });
    const nowS = Math.floor(Date.now() / 1000);
    for (const [code, exp] of this.codes) {
      if (exp > nowS) this.send({ t: "code", op: "put", code, exp });
      else this.codes.delete(code);
    }
    this.log("info", `已连上中继：${this.slug}.${this.base}（指纹 ${this.fp}）`);
    this.o.onWelcome?.(this.info());
  }

  private onError(f: ErrorFrame, from: string | undefined): void {
    if (typeof f.id === "string") {
      if (this.outbound.owns(f.id, from) || f.origin === "relay") {
        if (this.outbound.onError(f as ErrorFrame & { id: string })) return;
      }
      // 迟到帧（请求已超时 / 被取消，中继每帧回一条）只计数进流量摘要：积压时一分钟几十条，逐条记会淹掉日志
      if (f.code === "unknown_request") return this.traffic.onLate();
      return this.log("warn", `中继报错 ${f.code}（id=${f.id}）: ${f.message ?? ""}`);
    }
    this.lastError = remoteCode(f.code, "relay_error"); // 之后会拼进 connection_lost 的说明（见 request），中继能随意填
    this.log("warn", `中继拒绝连接: ${f.code} ${f.message ?? ""}`);
  }
}

export function connect(o: ConnectOptions): RelayClient {
  return new RelayClient(o);
}
