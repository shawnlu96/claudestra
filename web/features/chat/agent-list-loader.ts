/**
 * 会话列表请求的调度：单 flight（轮询 / 操作 / 重试撞上在途请求就合流，慢请求不会每 15s 叠一个）、超时可取消、
 * 失败有界退避 + jitter、联网 / 回前台提前重试；换数据源（切机器）或卸载时中止在途、清掉全部计时器，
 * 旧代号的迟到响应一律丢弃，不会盖掉新数据源。状态推导见 agent-list-state.ts；DOM 回归见 tests/web-dom-agent-list-recovery.test.ts。
 */
import {
  AGENT_LIST_TIMEOUT_MS, INITIAL_AGENT_LIST, SLOW_MS, fail, markSlow, shouldRequest, startRequest, succeed,
  type AgentListReason, type AgentListStatus,
} from "./agent-list-state";

export interface AgentListClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  random(): number;
  /** 页面在后台：到点的自动重试先不发，等回前台事件补上 */
  hidden(): boolean;
}

const realClock: AgentListClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
  // 经 globalThis 取：根目录 tsc（测试会 import 本文件）不带 dom lib
  hidden: () => (globalThis as { document?: { visibilityState?: string } }).document?.visibilityState === "hidden",
};

let defaultClock = realClock;
/** 测试注入假时钟（tests/web-dom-agent-list-recovery.test.ts）；在建 store 之前调用，null = 还原 */
export function setAgentListClockForTest(c: AgentListClock | null): void {
  defaultClock = c ?? realClock;
}

/** 与 loader 同一个时钟的「现在」：倒计时文案用它算，测试拨假时钟时文案跟着走 */
export function agentListNow(): number {
  return defaultClock.now();
}

export interface AgentListDeps<T> {
  /** 发请求；signal 在换源 / 卸载 / 超时时 abort */
  fetch(signal: AbortSignal, timeoutMs: number): Promise<T>;
  onStatus(s: AgentListStatus): void;
  /** 本数据源的新鲜成功响应（旧代号的不会到这里） */
  onData(data: T, reason: AgentListReason): void;
  /** 失败留痕（client.log）：前 3 次和之后每 10 次记一条，断网时不刷屏 */
  log?(msg: string): void;
  clock?: AgentListClock;
}

export class AgentListLoader<T> {
  private status: AgentListStatus = INITIAL_AGENT_LIST;
  private gen = 0;
  private inflight: { promise: Promise<boolean>; ctrl: AbortController } | null = null;
  /** 在途期间来的 action：等在途的结束后再补拉一次（在途那次可能早于操作），多个 action 合成一次 */
  private queued: Promise<boolean> | null = null;
  private retryTimer: unknown = null;
  private slowTimer: unknown = null;
  private readonly clock: AgentListClock;

  constructor(private readonly deps: AgentListDeps<T>) {
    this.clock = deps.clock ?? defaultClock;
  }

  get state(): AgentListStatus {
    return this.status;
  }

  /** 还挂着的计时器数（卸载 / 换源后必须是 0） */
  liveTimers(): number {
    return (this.retryTimer === null ? 0 : 1) + (this.slowTimer === null ? 0 : 1);
  }

  /** 拉一次；resolve true = 拿到了本数据源的新鲜列表。在途时合流到在途那一个（action 排在它后面补一次） */
  request(reason: AgentListReason): Promise<boolean> {
    if (this.inflight) {
      if (reason === "manual" && !this.status.manual) this.set({ ...this.status, manual: true });
      if (reason !== "action") return this.inflight.promise;
      const gen = this.gen;
      return (this.queued ??= this.inflight.promise.then(() => {
        this.queued = null;
        return gen === this.gen ? this.request("action") : false;
      }));
    }
    if (!shouldRequest(this.status, reason, this.clock.now())) return Promise.resolve(false);
    this.clearTimer("retryTimer");
    const gen = this.gen;
    const ctrl = new AbortController();
    this.set(startRequest(this.status, reason));
    this.slowTimer = this.clock.setTimeout(() => {
      this.slowTimer = null;
      if (gen === this.gen) this.set(markSlow(this.status));
    }, SLOW_MS);
    const promise = this.run(gen, ctrl, reason);
    this.inflight = { promise, ctrl };
    return promise;
  }

  /** 挂载期：联网事件提前重试；返回的清理函数 = 卸载（stop） */
  attach(target: { addEventListener(type: "online", fn: () => void): void; removeEventListener(type: "online", fn: () => void): void }): () => void {
    const online = () => void this.request("event");
    target.addEventListener("online", online);
    return () => {
      target.removeEventListener("online", online);
      this.stop();
    };
  }

  /** 换数据源：中止在途、清计时器、状态回到「未请求」，旧代号的响应作废 */
  reset(): void {
    this.halt();
    this.set(INITIAL_AGENT_LIST);
  }

  /** 卸载：同样中止 + 清计时器，但保留「拿到过列表」——重新挂载（StrictMode 双挂）后接着用 */
  stop(): void {
    const wasLoading = this.status.phase === "loading";
    this.halt();
    if (wasLoading || this.status.retryAt !== null)
      this.set({ ...this.status, phase: this.status.loaded ? "ok" : "idle", slow: false, manual: false, retryAt: null });
  }

  private halt() {
    this.gen++;
    this.queued = null;
    this.clearTimer("retryTimer");
    this.clearTimer("slowTimer");
    const f = this.inflight;
    this.inflight = null;
    f?.ctrl.abort(new DOMException("agent list source changed", "AbortError"));
  }

  private async run(gen: number, ctrl: AbortController, reason: AgentListReason): Promise<boolean> {
    try {
      const data = await this.deps.fetch(ctrl.signal, AGENT_LIST_TIMEOUT_MS);
      if (gen !== this.gen) return false;
      this.settle();
      this.deps.onData(data, reason); // 先落列表再翻状态：首拉成功那一帧不会闪「暂无会话」
      this.set(succeed(this.status));
      return true;
    } catch (e) {
      if (gen !== this.gen) return false;
      this.settle();
      const next = fail(this.status, e, this.clock.now(), this.clock.random());
      this.set(next);
      if (next.failures <= 3 || next.failures % 10 === 0)
        this.deps.log?.(`agents 拉取失败 第${next.failures}次 ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
      if (next.retryAt !== null) this.scheduleRetry(next.retryAt - this.clock.now());
      return false;
    }
  }

  private settle() {
    this.inflight = null;
    this.clearTimer("slowTimer");
  }

  private scheduleRetry(ms: number) {
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null;
      if (!this.clock.hidden()) void this.request("poll");
    }, Math.max(0, ms));
  }

  private clearTimer(k: "retryTimer" | "slowTimer") {
    if (this[k] !== null) this.clock.clearTimeout(this[k]);
    this[k] = null;
  }

  private set(s: AgentListStatus) {
    this.status = s;
    this.deps.onStatus(s);
  }
}
