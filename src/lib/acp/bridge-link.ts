/**
 * ACP 宿主到 bridge 的 ws 连接：和 channel-server / Pi 扩展同一套协议（register → registered，ping / pong，
 * requestId 对回包），register 带 runtime=codex、transport=acp、abort:true（打断走 abort 帧 → session/cancel）。
 * 宿主和 channel-server 一样没有守护者，所以断了就退避重连、被顶替也不退出（退避后再抢回来，lib/link-policy.ts）：
 * bridge 重启不打断回合——回合在适配器里接着跑，重连之后流式条目接着推。tests/acp-bridge-link.test.ts。
 */
import { decideAfterReplaced } from "../link-policy.js";

const BACKOFF_BASE_MS = 3_000;
const BACKOFF_MAX_MS = 60_000;
/** 连着这么久才把退避计数清零：刚连上就被踢的不算数（和 channel-server 同一口径） */
const STABLE_HOLD_MS = 30_000;
const PING_MS = 25_000;

export interface BridgeLinkDeps {
  url: string;
  registerFrame(): Record<string, unknown>;
  /** 除 registered / pong / 自己请求的回包之外的所有帧 */
  onFrame(msg: Record<string, any>): void;
  onRegistered(): void;
  onDown(why: string): void;
  log(msg: string): void;
  /** 单测注入 */
  WebSocketImpl?: typeof WebSocket;
}

export class BridgeLink {
  private ws: WebSocket | null = null;
  private registered = false;
  private stopped = false;
  private attempts = 0;
  private replacedCount = 0;
  private replaced = false;
  private nextReq = 0;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private timers: ReturnType<typeof setTimeout | typeof setInterval>[] = [];

  constructor(private readonly deps: BridgeLinkDeps) {}

  get up(): boolean {
    return this.registered && this.ws?.readyState === 1;
  }

  connect(): void {
    if (this.stopped) return;
    const WS = this.deps.WebSocketImpl ?? WebSocket;
    const ws = new WS(this.deps.url);
    this.ws = ws;
    this.replaced = false;
    ws.onopen = () => ws.send(JSON.stringify(this.deps.registerFrame()));
    ws.onmessage = (e) => this.onMessage(String(e.data));
    ws.onclose = (e) => this.onClose(e.code);
    ws.onerror = () => this.deps.log("bridge 连接出错（下一次重连会再试）");
  }

  /** 发一帧；连接没好返回 false（调用方决定丢还是报错） */
  send(frame: Record<string, unknown>): boolean {
    if (!this.up) return false;
    this.ws!.send(JSON.stringify(frame));
    return true;
  }

  /** 发一帧并等 bridge 回 {type:"response", requestId}；连接没好 / 超时 / 断开都 reject */
  request<T = any>(frame: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    const requestId = `acphost_${++this.nextReq}`;
    return new Promise((resolve, reject) => {
      if (!this.send({ ...frame, requestId })) return reject(new Error("bridge 连接还没好"));
      const timer = setTimeout(() => (this.pending.delete(requestId), reject(new Error(`${String(frame.type)} 等回包超时`))), timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
    });
  }

  close(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t as ReturnType<typeof setTimeout>), clearInterval(t as ReturnType<typeof setInterval>);
    this.ws?.close(1000);
  }

  private onMessage(raw: string): void {
    let m: Record<string, any>;
    try {
      m = JSON.parse(raw);
    } catch {
      return this.deps.log("bridge 发来一帧不是 JSON，丢掉");
    }
    if (m.type === "registered") return this.onRegisteredFrame();
    if (m.type === "pong") return;
    if (m.type === "replaced") return void (this.replaced = true);
    if (m.type === "response" && typeof m.requestId === "string" && this.pending.has(m.requestId)) {
      const p = this.pending.get(m.requestId)!;
      this.pending.delete(m.requestId);
      clearTimeout(p.timer);
      return m.error ? p.reject(new Error(String(m.error))) : p.resolve(m.result);
    }
    this.deps.onFrame(m);
  }

  private onRegisteredFrame(): void {
    this.registered = true;
    this.attempts = 0;
    this.timers.push(setTimeout(() => (this.replacedCount = 0), STABLE_HOLD_MS));
    this.timers.push(setInterval(() => this.ws?.readyState === 1 && this.ws.send(JSON.stringify({ type: "ping" })), PING_MS));
    this.deps.onRegistered();
  }

  private onClose(code: number): void {
    const wasUp = this.registered;
    this.registered = false;
    this.ws = null;
    for (const t of this.timers.splice(0)) clearTimeout(t as ReturnType<typeof setTimeout>), clearInterval(t as ReturnType<typeof setInterval>);
    for (const [id, p] of this.pending) clearTimeout(p.timer), p.reject(new Error("bridge 连接断开")), this.pending.delete(id);
    if (this.stopped) return;
    let delay: number;
    if (this.replaced || code === 4001) {
      // 被顶替：宿主进程一直在（它就是这个 agent），退避后回去抢，不退出（link-policy 的 stdio 判据对宿主恒为「还在用」）
      delay = decideAfterReplaced({ mcpClosed: false, consecutiveReplaced: ++this.replacedCount }).delayMs;
    } else {
      this.attempts++;
      delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, Math.min(this.attempts - 1, 5)), BACKOFF_MAX_MS);
    }
    this.deps.log(`bridge 连接断了（code ${code}${this.replaced ? "，被顶替" : ""}），${delay / 1000}s 后重连`);
    if (wasUp) this.deps.onDown(`code ${code}`);
    this.timers.push(setTimeout(() => this.connect(), delay));
  }
}
