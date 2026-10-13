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

/** 一代连接尝试。只有 `link.cur === 这一代` 时它的回调才算数；被换下的旧代回调一律空转。 */
interface Attempt {
  readonly gen: number;
  readonly ws: LinkSocket;
  readonly promise: Promise<void>;
  resolve: () => void;
  reject: (e: unknown) => void;
  registered: boolean;
  /** 本代收到过 replaced 帧：每代独立，旧代残留的标记不会让下一次普通断开被当成顶替 */
  replaced: boolean;
  keepalive: Timer | null;
  stableHold: Timer | null;
}

/**
 * 单飞：任一时刻至多一代在 connecting / connected；30s fallback 和迟到的 initialized 都走 connect()，
 * 后到者沿用同一代。旧 socket 的迟到 close / error / message 与旧 timer 只认自己那一代，
 * 不会清掉新一代的 registered / pending / keepalive，也不会再发起一代（tests/channel-link-audit-generation.test.ts）。
 */
export class ChannelLink {
  private cur: Attempt | null = null;
  private gen = 0;
  private reconnectTimer: Timer | null = null;
  private stopped = false;
  private readonly pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: Timer }>();
  private readonly queued: QueuedSender[] = [];
  private requestCounter = 0;
  private reconnectAttempts = 0;
  private consecutiveReplaced = 0;
  private readonly t: LinkTimers;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: ChannelLinkDeps) {
    this.t = deps.timers ?? realTimers;
    this.log = deps.log ?? ((l) => console.error(l));
  }

  isRegistered(): boolean { return !!this.cur?.registered; }
  pendingCount(): number { return this.pending.size; }
  queuedCount(): number { return this.queued.length; }

  /** 当前链路开着就发（Codex 换线程重发 register、typein 失败回报）；没开返回 false。 */
  sendIfOpen(data: string): boolean {
    const ws = this.cur?.ws;
    if (!ws || ws.readyState !== WS_OPEN) return false;
    ws.send(data);
    return true;
  }

  /**
   * 已有一代在连 / 已连上 → 返回同一个 promise，不另建 socket。
   * 退避等待中 → 拒绝而不提前建连：提前连会绕过 link-policy 的顶替 / 被拒退避，到点由 timer 发起下一代。
   */
  connect(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("链路已停止（MCP stdio 已关闭）"));
    if (this.cur) return this.cur.promise;
    if (this.reconnectTimer) return Promise.reject(new Error("退避中，到点自动重连"));
    return this.startAttempt().promise;
  }

  /** stdio 关闭：终止所有 timer，拒绝 pending 与排队请求，关掉当前 socket，之后不再重连。 */
  stop(reason: string) {
    this.stopped = true;
    if (this.reconnectTimer) { this.t.clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const a = this.cur;
    if (a) {
      this.retire(a);
      a.reject(new Error(reason));
      try { a.ws.close(1000); } catch { /* 关不掉也无妨：cur 已置空，它之后的回调全部空转 */ }
    }
    this.rejectPending(reason);
    this.rejectQueued(reason);
  }

  private startAttempt(): Attempt {
    let resolve!: () => void, reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    promise.catch(() => {}); // 调用方各自 catch；这里只防「重连 timer 发起、没人等」的一代拒绝成未处理异常
    const a: Attempt = {
      gen: ++this.gen, ws: this.deps.createSocket(), promise, resolve, reject,
      registered: false, replaced: false, keepalive: null, stableHold: null,
    };
    this.cur = a;
    a.ws.onopen = () => this.onOpen(a);
    a.ws.onmessage = (event) => this.onMessage(a, event);
    a.ws.onerror = (err) => {
      if (this.cur !== a) return;
      this.log(`Bridge WebSocket 错误: ${String((err as any)?.message ?? err)}`);
      if (!a.registered) a.reject(err);
    };
    a.ws.onclose = (event) => this.onClose(a, event);
    return a;
  }

  private onOpen(a: Attempt) {
    if (this.cur !== a) {
      try { a.ws.close(1000); } catch { /* 旧代 socket 关不掉也不发 register，它的回调全部空转 */ }
      return;
    }
    a.ws.send(this.deps.registerFrame()); // 退避计数在 registered 才清零：连上就清的话被拒（4002）的一方会每 3 秒撞一次
    this.startKeepalive(a);
  }

  private onMessage(a: Attempt, event: { data: unknown }) {
    if (this.cur !== a) return;
    let msg: any;
    try { msg = JSON.parse(typeof event.data === "string" ? event.data : ""); } catch { return; }
    if (msg.type === "registered") {
      a.registered = true;
      this.reconnectAttempts = 0;
      this.deps.onRegistered?.();
      if (this.consecutiveReplaced > 0) this.armStableHold(a);
      this.flushQueued();
      a.resolve();
    } else if (msg.type === "response") this.settleResponse(msg);
    else if (msg.type === "message") this.deps.onInbound(msg.content, msg.meta);
    else if (msg.type === "replaced") {
      a.replaced = true;
      this.log(`❎ 被新连接取代 (${msg.reason || "unknown"})`);
    }
  }

  private onClose(a: Attempt, event: { code: number; reason?: string }) {
    if (this.cur !== a) return; // 旧代迟到的 close：新一代的状态一个都不碰
    this.retire(a);
    a.reject(new Error(`Bridge 连接关闭（第 ${a.gen} 代，code ${event.code}）`));
    this.rejectPending("Bridge 连接断开");
    const delay = this.delayAfterClose(event, a.replaced);
    if (delay === null || this.stopped) return;
    this.reconnectTimer = this.t.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped && !this.cur) this.startAttempt();
    }, delay);
  }

  /** 把这一代从当前位置撤下并停掉它的 timer（没撑满 30s 就被踢 → 这次持有不算数，顶替计数保留）。 */
  private retire(a: Attempt) {
    if (this.cur === a) this.cur = null;
    if (a.keepalive) { this.t.clearInterval(a.keepalive); a.keepalive = null; }
    if (a.stableHold) { this.t.clearTimeout(a.stableHold); a.stableHold = null; }
  }

  request(msg: any, timeoutMs = 30_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const ready = this.cur?.registered && this.cur.ws.readyState === WS_OPEN;
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
        this.stopped = true;
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
  private armStableHold(a: Attempt) {
    if (a.stableHold) this.t.clearTimeout(a.stableHold);
    a.stableHold = this.t.setTimeout(() => {
      a.stableHold = null;
      if (this.cur !== a) return;
      if (this.consecutiveReplaced > 0) {
        this.log(`✅ 频道稳定持有 30s，顶替计数归零（此前 ${this.consecutiveReplaced} 次）`);
        this.consecutiveReplaced = 0;
      }
    }, STABLE_HOLD_MS);
    (a.stableHold as any).unref?.();
  }

  private startKeepalive(a: Attempt) {
    if (a.keepalive) this.t.clearInterval(a.keepalive);
    a.keepalive = this.t.setInterval(() => {
      if (this.cur !== a) { this.t.clearInterval(a.keepalive!); a.keepalive = null; return; }
      if (a.ws.readyState !== WS_OPEN) return;
      try { a.ws.send(JSON.stringify({ type: "ping" })); } catch { /* ping 发不出去说明链路已断，onclose 会接手重连 */ }
    }, KEEPALIVE_MS);
  }

  private settleResponse(msg: any) {
    const p = this.pending.get(msg.requestId);
    if (!p) return;
    this.pending.delete(msg.requestId);
    this.t.clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  }

  private doSend(msg: any, resolve: (v: any) => void, reject: (e: Error) => void, timeoutMs: number) {
    const ws = this.cur?.ws;
    if (!ws || ws.readyState !== WS_OPEN) return reject(new Error("Bridge 未连接（doSend 时 WS 不可用）"));
    const requestId = `req_${++this.requestCounter}`;
    msg.requestId = requestId;
    const timer = this.t.setTimeout(() => {
      if (this.pending.delete(requestId)) reject(new Error("Bridge 请求超时"));
    }, timeoutMs);
    this.pending.set(requestId, { resolve, reject, timer });
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
      this.t.clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
  }
}
