/**
 * channel-server ↔ bridge 的 WebSocket 链路（连接、注册、keepalive、退避重连、grace 队列、请求应答）。
 * 抽出来是为了能在测试里用假 socket / 假时钟驱动：channel-server.ts 顶层有副作用，不能 import。
 */
import { decideAfterReplaced, reconnectDelayMs, REJECTED_CLOSE_CODE } from "./link-policy.js";

const WS_OPEN = 1;
export const GRACE_QUEUE_MS = 15_000;
export const KEEPALIVE_MS = 25_000;
export const STABLE_HOLD_MS = 30_000;

/** 只用到的 WebSocket 子集；真 WebSocket 结构上满足它。 */
export interface LinkSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
}

type Timer = ReturnType<typeof setTimeout>;
export interface LinkTimers {
  setTimeout(fn: () => void, ms: number): Timer;
  clearTimeout(t: Timer): void;
  setInterval(fn: () => void, ms: number): Timer;
  clearInterval(t: Timer): void;
}
const realTimers: LinkTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  setInterval: (fn, ms) => setInterval(fn, ms) as unknown as Timer,
  clearInterval: (t) => clearInterval(t as any),
};

export interface ChannelLinkDeps {
  createSocket: () => LinkSocket;
  registerFrame: () => string;
  /** registered 帧到达（Codex 用来标就绪）。 */
  onRegistered?: () => void;
  /** bridge 推来的 type:"message"。 */
  onInbound: (content: string, meta: Record<string, string>) => void;
  isMcpClosed: () => boolean;
  /** 被顶替且 stdio 已关：真进程里是 process.exit(0)。 */
  exit: (reason: string) => void;
  log?: (line: string) => void;
  timers?: LinkTimers;
}

interface QueuedSender { send: () => void; reject: (e: Error) => void; timer: Timer }

export class ChannelLink {
  private ws: LinkSocket | null = null;
  private registered = false;
  private replaced = false;
  private readonly pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private readonly queued: QueuedSender[] = [];
  private requestCounter = 0;
  private reconnectAttempts = 0;
  private consecutiveReplaced = 0;
  private stableHoldTimer: Timer | null = null;
  private keepaliveTimer: Timer | null = null;
  private readonly t: LinkTimers;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: ChannelLinkDeps) {
    this.t = deps.timers ?? realTimers;
    this.log = deps.log ?? ((l) => console.error(l));
  }

  isRegistered(): boolean { return this.registered; }
  pendingCount(): number { return this.pending.size; }
  queuedCount(): number { return this.queued.length; }

  /** 当前链路开着就发（Codex 换线程重发 register、typein 失败回报）；没开返回 false。 */
  sendIfOpen(data: string): boolean {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return false;
    this.ws.send(data);
    return true;
  }

  connect(): Promise<void> {
    this.replaced = false;
    return new Promise((resolve, reject) => {
      const ws = this.deps.createSocket();
      ws.onopen = () => {
        this.ws = ws;
        ws.send(this.deps.registerFrame());
        this.startKeepalive();
      };
      ws.onmessage = (event) => {
        let msg: any;
        try { msg = JSON.parse(typeof event.data === "string" ? event.data : ""); } catch { return; }
        if (msg.type === "registered") {
          this.registered = true;
          this.reconnectAttempts = 0;
          this.deps.onRegistered?.();
          if (this.consecutiveReplaced > 0) this.armStableHold();
          this.flushQueued();
          resolve();
        } else if (msg.type === "response") this.settleResponse(msg);
        else if (msg.type === "message") this.deps.onInbound(msg.content, msg.meta);
        else if (msg.type === "replaced") {
          this.replaced = true;
          this.log(`❎ 被新连接取代 (${msg.reason || "unknown"})`);
        }
      };
      ws.onerror = (err) => {
        this.log(`Bridge WebSocket 错误: ${String((err as any)?.message ?? err)}`);
        if (!this.registered) reject(err);
      };
      ws.onclose = (event) => {
        this.ws = null;
        this.registered = false;
        this.stopKeepalive();
        if (this.stableHoldTimer) { this.t.clearTimeout(this.stableHoldTimer); this.stableHoldTimer = null; }
        this.rejectPending("Bridge 连接断开");
        const delay = this.delayAfterClose(event, this.replaced);
        if (delay === null) return;
        this.t.setTimeout(() => { this.connect().catch(() => {}); }, delay);
      };
    });
  }

  request(msg: any, timeoutMs = 30_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const ready = this.ws && this.ws.readyState === WS_OPEN && this.registered;
      if (ready) return this.doSend(msg, resolve, reject, timeoutMs);
      const entry: QueuedSender = {
        send: () => this.doSend(msg, resolve, reject, timeoutMs),
        reject,
        timer: this.t.setTimeout(() => {
          const idx = this.queued.indexOf(entry);
          if (idx >= 0) this.queued.splice(idx, 1);
          reject(new Error(`Bridge 断开超 ${GRACE_QUEUE_MS}ms 没恢复`));
        }, GRACE_QUEUE_MS),
      };
      this.queued.push(entry);
      this.log(`⏸ WS 断开，请求入队等重连（队列长度=${this.queued.length}）`);
    });
  }

  /** 被顶替（4001 / replaced）/ 被拒（4002）/ 普通断线的退避毫秒数；null = 已决定退出。 */
  private delayAfterClose(event: { code: number; reason?: string }, replaced: boolean): number | null {
    if (replaced || event.code === 4001) {
      this.consecutiveReplaced++;
      const d = decideAfterReplaced({ mcpClosed: this.deps.isMcpClosed(), consecutiveReplaced: this.consecutiveReplaced });
      if (d.action === "exit") {
        this.log(`👋 channel-server 退出（${d.reason}）`);
        this.rejectQueued("channel-server 被新连接取代"); // Claude Code 立刻收到错误，不用等 15s 超时
        this.deps.exit(d.reason);
        return null;
      }
      this.log(`⚠️ 被新连接顶替 —— ${d.reason}，${d.delayMs / 1000}s 后重新注册`);
      return d.delayMs;
    }
    if (event.code === REJECTED_CLOSE_CODE) this.log(`⛔ bridge 拒绝注册（${event.reason}）：频道由已验证身份的会话持有，退避后再试，不退出`);
    return reconnectDelayMs(++this.reconnectAttempts); // 普通断线与被拒（4002）同一条指数退避：3s → 60s
  }

  /** 拿回频道后先别清零顶替计数：稳定持有 30s 才算真赢，长期对抢时退避自动降频（3→60s）。 */
  private armStableHold() {
    if (this.stableHoldTimer) this.t.clearTimeout(this.stableHoldTimer);
    this.stableHoldTimer = this.t.setTimeout(() => {
      this.stableHoldTimer = null;
      if (this.consecutiveReplaced > 0) {
        this.log(`✅ 频道稳定持有 30s，顶替计数归零（此前 ${this.consecutiveReplaced} 次）`);
        this.consecutiveReplaced = 0;
      }
    }, STABLE_HOLD_MS);
    (this.stableHoldTimer as any).unref?.();
  }

  private startKeepalive() {
    this.stopKeepalive();
    this.keepaliveTimer = this.t.setInterval(() => {
      if (this.ws && this.ws.readyState === WS_OPEN) {
        try { this.ws.send(JSON.stringify({ type: "ping" })); } catch { /* ping 发不出去说明链路已断，onclose 会接手重连 */ }
      }
    }, KEEPALIVE_MS);
  }
  private stopKeepalive() {
    if (this.keepaliveTimer) { this.t.clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
  }

  private settleResponse(msg: any) {
    const p = this.pending.get(msg.requestId);
    if (!p) return;
    this.pending.delete(msg.requestId);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  }

  private doSend(msg: any, resolve: (v: any) => void, reject: (e: Error) => void, timeoutMs: number) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return reject(new Error("Bridge 未连接（doSend 时 WS 不可用）"));
    const requestId = `req_${++this.requestCounter}`;
    msg.requestId = requestId;
    this.pending.set(requestId, { resolve, reject });
    const timer = this.t.setTimeout(() => {
      if (this.pending.delete(requestId)) reject(new Error("Bridge 请求超时"));
    }, timeoutMs);
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      this.t.clearTimeout(timer);
      this.pending.delete(requestId);
      reject(err as Error);
    }
  }

  private flushQueued() {
    if (!this.queued.length) return;
    this.log(`🔁 WS 恢复，flush ${this.queued.length} 个排队请求`);
    const snapshot = this.queued.splice(0, this.queued.length); // 先清空，send 路径里再入队不会死循环
    for (const q of snapshot) {
      this.t.clearTimeout(q.timer);
      try { q.send(); } catch (err) { q.reject(err as Error); }
    }
  }

  private rejectQueued(reason: string) {
    if (!this.queued.length) return;
    this.log(`❌ ${reason}，reject ${this.queued.length} 个排队请求`);
    for (const q of this.queued.splice(0, this.queued.length)) {
      this.t.clearTimeout(q.timer);
      q.reject(new Error(reason));
    }
  }

  private rejectPending(reason: string) {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new Error(reason));
    }
  }
}
