/**
 * 回合状态机（I1–I8、I10 的回合部分、I13、I14 的回合一侧）。同一线程同一时刻只有一轮：
 * - 待开始（Pending）：turn/start / compact/start 已发、还没拿到 turnId。这期间不认识的 turnId 的事件进早到缓冲，归属后重放（I3）；
 *   compact 回 {} 后认第一个不认识的 turn/started。确认超时 / 坏回包 / 错误 / 写出后断线一律转对账（I14），对账只能证明已投递。
 * - 派生状态（I5）：认识的回合在 start 回包那一刻发 active，自发回合在 turn/started 发；每轮收尾恰好一个 idle，带终态信封；
 *   app-server 原始的 active / idle / systemError 都不转发。systemError 5s 等不到 turn/completed 就合成失败，迟到的 completed 只记日志，
 *   下一轮开始前先用 thread/read 核对，旧回合还在跑就 interrupt 一次、最多等 5s，等不到走 I12（不让两轮叠在一起）。
 * - steer 串行（B19）：有回合在跑就 turn/steer，否则等上一轮收尾再另起；startedNewTurn 在 turn/start 回包的同步钩子里写（I3）。
 *   cancel 时本地没发出的 steer 一律回 failed，绝不在 cancel 之后自己另起一轮（B21）。
 * - interrupt 每个 turnId 最多发一次、3s 时限，回包不算「已打断」，只认 turn/completed interrupted（I4）。
 * tests/codex-adapter-turns.test.ts、tests/codex-adapter-delivery.test.ts。
 */
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { RpcError, RpcLostError } from "../rpc.js";
import type { AppServer, NotificationEvent } from "./app-server.js";
import { closeTurn, eventState, type EventState, type HostCaps, promptUsage, type TokenUsage, updatesFor } from "./events.js";
import { deliveryUnknownError, envelopeFailure, failureOf, promptFailureResult, protocolFailure, transportLost, type TurnFailure } from "./failures.js";
import type { ParamsOf } from "./protocol.js";
import type { SessionState } from "./session-state.js";

type Rec = Record<string, unknown>;
/** 当场写出这条 ACP 请求的回包（rpc.ts ReplyCtx） */
export interface Ctx {
  respond(r: unknown): void;
  fail(e: unknown): void;
}
type Origin = "prompt" | "steer" | "compact" | "self";
type Status = "completed" | "interrupted" | "failed";

/** 对账（delivery.ts）：只能证明已投递，查不到 / 查不完整都返回 null */
export interface Reconciler {
  userMessage(threadId: string, clientId: string, sentAt: number, live: (clientId: string) => string | undefined): Promise<string | null>;
  compaction(threadId: string, sentAt: number, known: ReadonlySet<string>): Promise<string | null>;
}

/** 要走 I12 的原因：exit = app-server 没了；protocol = 线路作废；unknown = 投递结果不明；stale = 旧回合停不下来 */
export interface FatalCause {
  kind: "exit" | "protocol" | "unknown" | "stale" | "stop";
  why: string;
}

const TIMINGS = { ackMs: 30_000, sysErrMs: 5_000, staleWaitMs: 5_000, interruptMs: 3_000, watchdogMs: 600_000 };
export type TurnTimings = typeof TIMINGS;
/** 早到缓冲（I13）：单个 turnId 最多这么多条、总共这么多字节，超了作废连接 */
const EARLY_MAX = 1_000;
const EARLY_BYTES = 4 * 1024 * 1024;
const STEER_MAX = 50;
const RECENT_MAX = 500;
const COMPACT_RE = /^\s*\/compact(\s|$)/i;

export interface TurnsDeps {
  app: Pick<AppServer, "call">;
  session: SessionState;
  caps(): HostCaps;
  /** turn/start 里随模式和配置走的字段 */
  policy(): Omit<ParamsOf<"turn/start">, "threadId" | "input" | "clientUserMessageId">;
  emit(update: Rec): void;
  fatal(c: FatalCause): void;
  log(msg: string): void;
  reconcile?: Reconciler;
  /** 有命令开始执行：进程树马上补扫一次（proc-tree.ts） */
  onCommand?(): void;
  /** 一轮收尾（turnId）：还在等宿主答复的审批按 cancel 答（approvals.ts） */
  onFinish?(turnId: string): void;
  timings?: Partial<TurnTimings>;
}

interface Turn {
  id: string;
  epoch: number;
  origin: Origin;
  ctx?: Ctx;
  cancelRequested: boolean;
  interruptSent: boolean;
  finished: boolean;
  /** 合成失败收尾之后，真实的 turn/completed 到了（I13） */
  realCompleted: boolean;
  failure?: TurnFailure;
  degraded?: string;
  sysErr: boolean;
  steers: { clientId: string; text: string }[];
  consumed: Set<string>;
  ev: EventState;
  timers: ReturnType<typeof setTimeout>[];
  lastEventAt: number;
}

interface Pending {
  epoch: number;
  origin: Exclude<Origin, "self">;
  ctx: Ctx;
  text: string;
  clientId?: string;
  sentAt: number;
  written: boolean;
  acked: boolean;
  cancelRequested: boolean;
  unknown?: string;
  known?: ReadonlySet<string>;
}

interface QueuedSteer {
  text: string;
  ctx: Ctx;
  epoch: number;
  cancelSeq: number;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** 能证明一个字节都没写给 app-server 的失败：连接早断了，或我们自己的参数没过 schema */
const unsent = (e: unknown) => (e instanceof RpcLostError && !e.sent) || e instanceof ZodError;
const userText = (text: string) => [{ type: "text" as const, text, text_elements: [] as [] }];
const status = (type: string, turn?: Rec): Rec => ({ sessionUpdate: "session_info_update", _meta: { codex: { threadStatus: { type } }, ...(turn ? { claudestra: { turn } } : {}) } });
const notice = (text: string): Rec => ({ sessionUpdate: "session_info_update", _meta: { claudestra: { notice: text } } });

export class Turns {
  private readonly t: TurnTimings;
  private cur: Turn | null = null;
  private pending: Pending | null = null;
  private early = new Map<string, NotificationEvent[]>();
  private earlyBytes = 0;
  private recent = new Set<string>();
  private stale: Turn | null = null;
  private live = new Map<string, string>();
  private queue: QueuedSteer[] = [];
  private inflight: Ctx | null = null;
  private steering = false;
  private cancelSeq = 0;
  private stopped = false;
  private waiters = new Set<() => void>();
  private warnedThread = false;
  /** 最近一次 thread/tokenUsage/updated 的 last，记下所属会话代际：跨回合保留（同 2.1.0 sessionState.lastTokenUsage），换会话不带过去 */
  private lastUsage: { epoch: number; last: TokenUsage } | null = null;

  constructor(private readonly deps: TurnsDeps) {
    this.t = { ...TIMINGS, ...deps.timings };
  }

  /** 这条审批属于当前会话里正在跑、还没收尾的那一轮（approvals.ts 据此把过期的审批直接 cancel） */
  owns(threadId: string, turnId: string): boolean {
    return threadId === this.deps.session.current && this.cur?.id === turnId && !this.cur.finished;
  }

  get busy(): boolean {
    return !!this.pending || !!this.cur || this.queue.length > 0 || this.steering || !!this.inflight;
  }

  // ---- ACP 一侧 ----

  /** session/prompt：回包在收尾时经 ctx 写（先 idle 后回包）。忙时回 -32600（B26） */
  prompt(text: string, ctx: Ctx): void {
    if (this.busy) throw new RpcError(-32600, "已经有一轮在跑，同一时刻只能有一轮");
    void this.start(this.newPending(COMPACT_RE.test(text) ? "compact" : "prompt", text, ctx));
  }

  /** _session/steering：排进本地队列串行处理，超过上限的回 failed（还没投递，宿主重排不会重复执行） */
  steer(text: string, ctx: Ctx): void {
    if (this.stopped || this.queue.length >= STEER_MAX) return ctx.respond({ outcome: "failed" });
    this.queue.push({ text, ctx, epoch: this.deps.session.epoch, cancelSeq: this.cancelSeq });
    void this.pumpSteers();
  }

  /** session/cancel：只作用于待开始或当前未收尾的回合；本地排着的 steer 全部回 failed */
  cancel(): void {
    this.cancelSeq++;
    for (const s of this.queue.splice(0)) s.ctx.respond({ outcome: "failed" });
    const t = this.cur;
    if (t) {
      t.cancelRequested = true;
      this.interrupt(t);
    } else if (this.pending) this.pending.cancelRequested = true;
    this.wake();
  }

  /** I12 ①：不再开新回合，等着的续体全部放行 */
  stop(): void {
    this.stopped = true;
    this.wake();
  }

  /** I12 ⑥：所有没收尾的各以失败收尾一次；tail = 仍存活的相关进程（写进结果不明的卡） */
  failAll(cause: FatalCause, tail: string): void {
    const why = `${cause.why}${tail}`;
    if (this.cur) this.finish(this.cur, { status: "failed", fail: cause.kind === "protocol" ? protocolFailure(why) : transportLost(why, cause.kind === "unknown") });
    const p = this.pending;
    if (p) {
      this.pending = null;
      if (p.written) this.unknownResult(p, `${p.unknown ?? cause.why}${tail}`);
      else this.dropped(p, "unsent", why);
    }
    this.inflight?.respond({ outcome: "deliveredUnknown", message: `插话写给了 Codex 却没拿到确认，已停止本地执行，不会重发（${why}）` });
    this.inflight = null;
    for (const s of this.queue.splice(0)) s.ctx.respond({ outcome: "failed" });
  }

  // ---- 开一轮 ----

  private newPending(origin: Pending["origin"], text: string, ctx: Ctx): Pending {
    return { epoch: this.deps.session.epoch, origin, ctx, text, sentAt: 0, written: false, acked: false, cancelRequested: false };
  }

  private async start(p: Pending): Promise<void> {
    this.pending = p;
    if (!(await this.clearStale()) || this.pending !== p) return;
    if (p.cancelRequested || this.stopped) return this.dropped(p, p.cancelRequested ? "cancelled" : "unsent", "适配器正在退出");
    if (p.origin === "compact") return this.startCompact(p);
    const threadId = this.deps.session.current!;
    p.clientId = randomUUID();
    p.sentAt = Date.now();
    p.written = true;
    const params = { threadId, input: userText(p.text), clientUserMessageId: p.clientId, ...this.deps.policy() };
    try {
      await this.deps.app.call("turn/start", params, { timeoutMs: this.t.ackMs, onResult: (r) => this.claim(p, r.turn.id) });
    } catch (e) {
      if (this.pending === p) await this.unclear(p, e, () => this.live.get(p.clientId!), (r) => r.userMessage(threadId, p.clientId!, p.sentAt, (id) => this.live.get(id)));
    }
  }

  private async startCompact(p: Pending): Promise<void> {
    const threadId = this.deps.session.current!;
    p.sentAt = Date.now();
    p.written = true;
    p.known = new Set(this.recent);
    const reconcile = () => this.unclear(p, new Error(`thread/compact/start 回了 {}，但 ${this.t.ackMs}ms 内压缩回合没开始`), () => this.liveCompaction(), (r) => r.compaction(threadId, p.sentAt, p.known!));
    try {
      await this.deps.app.call("thread/compact/start", { threadId }, { timeoutMs: this.t.ackMs });
    } catch (e) {
      if (this.pending === p) await this.unclear(p, e, () => this.liveCompaction(), (r) => r.compaction(threadId, p.sentAt, p.known!));
      return;
    }
    if (this.pending !== p) return;
    p.acked = true;
    const started = [...this.early].find(([, evs]) => evs.some((e) => e.method === "turn/started"));
    if (started) return this.claim(p, started[0]);
    if (!(await this.until(() => this.pending !== p, this.t.ackMs)) && this.pending === p && !this.stopped) await reconcile();
  }

  /** 早到缓冲里已经出现 contextCompaction 开始的那一轮 */
  private liveCompaction(): string | undefined {
    return [...this.early].find(([, evs]) => evs.some((e) => e.method === "item/started" && e.ok && e.params.item.type === "contextCompaction"))?.[0];
  }

  /** 输入可能已经写出却没拿到可信结果：先看实时记录，再查历史；找到就接管，找不到判结果不明、走 I12（I14） */
  private async unclear(p: Pending, e: unknown, live: () => string | undefined, history: (r: Reconciler) => Promise<string | null>): Promise<void> {
    const why = errText(e);
    if (unsent(e)) return this.dropped(p, "unsent", why);
    this.deps.log(`${p.origin === "compact" ? "thread/compact/start" : "turn/start"} 拿不到可信结果（${why}），对账`);
    const found = live() ?? (this.deps.reconcile && !this.stopped ? await history(this.deps.reconcile).catch(this.reconcileError) : null);
    if (this.pending !== p || this.stopped) return;
    if (found) return this.claim(p, found);
    p.unknown = why;
    this.deps.fatal({ kind: "unknown", why: `用户输入投递结果不明：${why}` });
  }

  /** 拿到 turnId：登记、（steer 另起的）先写 steer 回包、再发 active、再重放早到的事件（I3，都在处理下一行之前） */
  private claim(p: Pending, turnId: string): void {
    if (this.pending !== p) return;
    this.pending = null;
    const t = this.newTurn(turnId, p.origin, p.epoch, p.origin === "steer" ? undefined : p.ctx);
    if (p.origin === "steer") p.ctx.respond({ outcome: "startedNewTurn" });
    this.emitFor(t, status("active"));
    if (p.cancelRequested) {
      t.cancelRequested = true;
      this.interrupt(t);
    }
    const mine = this.early.get(turnId) ?? [];
    this.early.delete(turnId);
    for (const ev of mine) this.onEvent(ev);
    const rest = [...this.early.values()].flat();
    this.early.clear();
    this.earlyBytes = 0;
    for (const ev of rest) this.onEvent(ev);
    this.wake();
  }

  private dropped(p: Pending, how: "cancelled" | "unsent", why: string): void {
    if (this.pending === p) this.pending = null;
    if (p.origin === "steer") p.ctx.respond({ outcome: "failed" });
    else if (how === "cancelled") p.ctx.respond({ stopReason: "cancelled" });
    else p.ctx.fail(new RpcError(-32603, `没有发给 Codex（${why}）`));
    this.wake();
  }

  private unknownResult(p: Pending, why: string): void {
    if (p.origin === "steer") return p.ctx.respond({ outcome: "deliveredUnknown", message: `插话写给了 Codex 却没拿到确认，已停止本地执行，不会重发（${why}）` });
    const what = p.origin === "compact" ? "压缩可能已经开始或已经完成" : "Codex 适配器拿不到这条消息的确认";
    p.ctx.fail(deliveryUnknownError(`${what}；已停止本地执行，已经产生的效果没有撤销（${why}）`));
  }

  private newTurn(id: string, origin: Origin, epoch: number, ctx?: Ctx): Turn {
    const t: Turn = {
      id, epoch, origin, ctx, cancelRequested: false, interruptSent: false, finished: false, realCompleted: false, sysErr: false,
      steers: [], consumed: new Set(), ev: eventState(), timers: [], lastEventAt: Date.now(),
    };
    this.cur = t;
    this.armWatchdog(t);
    return t;
  }

  /** I13「合成失败之后」：旧回合在 app-server 里可能还在跑，先核对再开下一轮 */
  private async clearStale(): Promise<boolean> {
    const s = this.stale;
    if (!s || s.realCompleted) return (this.stale = null), true;
    let type: string;
    try {
      type = (await this.deps.app.call("thread/read", { threadId: this.deps.session.current!, includeTurns: false })).thread.status.type;
    } catch (e) {
      this.voidConnection(`开下一轮前核对旧回合的 thread/read 失败：${errText(e)}`);
      return false;
    }
    if (type === "active" && !s.realCompleted) {
      this.interrupt(s);
      if (!(await this.until(() => s.realCompleted, this.t.staleWaitMs))) {
        if (!this.stopped) this.deps.fatal({ kind: "stale", why: `已按失败收尾的回合 ${s.id} 在 app-server 里停不下来` });
        return false;
      }
    }
    this.stale = null;
    return true;
  }

  // ---- steer ----

  private async pumpSteers(): Promise<void> {
    if (this.steering) return;
    this.steering = true;
    try {
      while (this.queue.length && !this.stopped) {
        if (!(await this.until(() => !this.pending && !(this.cur?.origin === "compact")))) break;
        const s = this.queue.shift();
        if (!s) break;
        if (s.epoch !== this.deps.session.epoch || s.cancelSeq !== this.cancelSeq) {
          s.ctx.respond({ outcome: "failed" });
          continue;
        }
        const t = this.cur;
        if (t && !t.cancelRequested) await this.inject(s, t);
        else await this.steerNewTurn(s);
      }
    } finally {
      this.steering = false;
      this.wake();
    }
  }

  /** 当前回合正在被叫停 / 没有回合：等它收尾再另起；等的期间又被 cancel 了就不另起（B21、I8） */
  private async steerNewTurn(s: QueuedSteer): Promise<void> {
    if (!(await this.until(() => !this.cur && !this.pending)) || s.cancelSeq !== this.cancelSeq || s.epoch !== this.deps.session.epoch) {
      return s.ctx.respond({ outcome: "failed" });
    }
    await this.start(this.newPending("steer", s.text, s.ctx));
  }

  private async inject(s: QueuedSteer, t: Turn): Promise<void> {
    const threadId = this.deps.session.current!;
    const clientId = randomUUID();
    const sentAt = Date.now();
    this.inflight = s.ctx;
    const settle = (outcome: string) => {
      if (this.inflight !== s.ctx) return; // 收尾流程已经替它写了结果
      this.inflight = null;
      s.ctx.respond({ outcome });
    };
    try {
      await this.deps.app.call("turn/steer", { threadId, input: userText(s.text), expectedTurnId: t.id, clientUserMessageId: clientId }, { timeoutMs: this.t.ackMs });
      t.steers.push({ clientId, text: s.text });
      return settle("injected");
    } catch (e) {
      if (unsent(e)) return settle("failed");
      this.deps.log(`turn/steer 拿不到可信结果（${errText(e)}），对账`);
      const r = this.deps.reconcile;
      const found = this.live.get(clientId) ?? (r && !this.stopped ? await r.userMessage(threadId, clientId, sentAt, (id) => this.live.get(id)).catch(this.reconcileError) : null);
      if (found) return settle("injected");
      // 结果留给 failAll 在杀完进程后写（先 kill 后写结果，I12）
      if (this.inflight === s.ctx) this.deps.fatal({ kind: "unknown", why: `插话投递结果不明：${errText(e)}` });
    }
  }

  // ---- app-server 一侧 ----

  /** 已校验 threadId 是当前会话的通知（server.ts 先按线程过滤）。按 turnId 归属，归不了的进早到缓冲或作废连接（I7、I10） */
  onEvent(ev: NotificationEvent): void {
    if (ev.method === "thread/status/changed") return this.onThreadStatus(ev);
    const turnId = ev.corr.turnId;
    if (!turnId) return this.voidConnection(`app-server 的 ${ev.method} 缺 turnId`);
    this.noteLive(ev, turnId);
    const t = this.cur?.id === turnId ? this.cur : this.stale?.id === turnId ? this.stale : null;
    if (t && !t.finished) return this.onTurnEvent(t, ev);
    if (t || this.recent.has(turnId)) return this.onLate(t, ev);
    if (this.pending) return this.buffer(turnId, ev);
    if (ev.method === "turn/started" && ev.ok && !this.cur) return this.selfTurn(turnId);
    this.voidConnection(`app-server 的 ${ev.method} 带的 turnId ${turnId} 不属于任何已知或待开始的回合`);
  }

  private noteLive(ev: NotificationEvent, turnId: string): void {
    if (ev.method !== "item/started" || !ev.ok || ev.params.item.type !== "userMessage" || !ev.params.item.clientId) return;
    this.live.set(ev.params.item.clientId, turnId);
    if (this.live.size > RECENT_MAX) this.live.delete(this.live.keys().next().value as string);
    if (this.cur?.id === turnId) this.cur.consumed.add(ev.params.item.clientId);
  }

  private buffer(turnId: string, ev: NotificationEvent): void {
    const list = this.early.get(turnId) ?? [];
    list.push(ev);
    this.early.set(turnId, list);
    this.earlyBytes += JSON.stringify(ev.ok ? ev.params : ev.raw)?.length ?? 0;
    if (list.length > EARLY_MAX || this.earlyBytes > EARLY_BYTES) return this.voidConnection(`早到缓冲超限（${list.length} 条 / ${this.earlyBytes} 字节）`);
    const p = this.pending;
    if (p?.origin === "compact" && p.acked && ev.method === "turn/started") this.claim(p, turnId);
  }

  private selfTurn(turnId: string): void {
    const t = this.newTurn(turnId, "self", this.deps.session.epoch);
    this.deps.log(`app-server 自己开了一轮 ${turnId}`);
    this.emitFor(t, status("active"));
  }

  private onTurnEvent(t: Turn, ev: NotificationEvent): void {
    t.lastEventAt = Date.now();
    if (!ev.ok) {
      if (ev.cls === "L") return this.finish(t, { status: "failed", fail: protocolFailure(`app-server 发来不合格的 ${ev.method}：${ev.problem}`) });
      t.degraded ??= `${ev.method}：${ev.problem}`;
      return this.deps.log(`回合 ${t.id} 观测不完整（${t.degraded}），收尾时按失败报`);
    }
    if (ev.method === "turn/completed") return this.completed(t, ev.params.turn);
    if (ev.method === "error") {
      if (ev.params.willRetry) return this.deps.log(`app-server 报可重试错误（${ev.params.error.message}），等它自己重试`);
      t.failure = failureOf(ev.params.error);
      return;
    }
    if (ev.method === "item/started" && ev.params.item.type === "commandExecution") this.deps.onCommand?.();
    if (ev.method === "thread/tokenUsage/updated") this.lastUsage = { epoch: t.epoch, last: ev.params.tokenUsage.last };
    for (const u of updatesFor(t.ev, ev, this.deps.caps())) this.emitFor(t, u);
  }

  private completed(t: Turn, turn: { status: string; error?: { message: string; codexErrorInfo?: unknown } | null }): void {
    if (turn.status === "interrupted") return this.finish(t, { status: "interrupted" });
    if (turn.status === "failed") return this.finish(t, { status: "failed", fail: turn.error ? failureOf(turn.error) : (t.failure ?? failureOf({ message: "Codex 回合失败" })) });
    if (turn.status !== "completed") return this.finish(t, { status: "failed", fail: protocolFailure(`turn/completed 的 status 是 ${turn.status}`) });
    const fail = t.failure ?? (t.degraded ? protocolFailure(`这一轮有事件不合格，结果不完整（${t.degraded}）`) : undefined);
    this.finish(t, fail ? { status: "failed", fail } : { status: "completed" });
  }

  /** 已收尾回合迟到的事件：只记日志；合成失败的旧回合等到真实 completed 就记下（I13） */
  private onLate(t: Turn | null, ev: NotificationEvent): void {
    if (t && t === this.stale && ev.method === "turn/completed") {
      t.realCompleted = true;
      this.deps.log(`已合成收尾的回合 ${t.id} 迟到的 turn/completed 到了，只记日志`);
      this.wake();
    }
  }

  private onThreadStatus(ev: Extract<NotificationEvent, { method: "thread/status/changed" }>): void {
    const t = this.cur;
    if (!ev.ok) {
      if (t) return this.finish(t, { status: "failed", fail: protocolFailure(`app-server 发来不合格的 thread/status/changed：${ev.problem}`) });
      if (!this.warnedThread) this.deps.log(`app-server 发来不合格的 thread/status/changed（${ev.problem}），没有在跑的回合，只告警这一次`);
      this.warnedThread = true;
      return;
    }
    if (ev.params.status.type !== "systemError" || !t || t.sysErr) return;
    t.sysErr = true;
    const fail = () => t.failure ?? { kind: "internal_error" as const, title: `Codex 线程出错（systemError），${this.t.sysErrMs / 1000}s 内没等到回合结束` };
    t.timers.push(setTimeout(() => this.finish(t, { status: "failed", fail: fail(), synthesized: true }), this.t.sysErrMs));
  }

  // ---- 收尾 ----

  /** I1：一个 turnId 只收尾一次。补齐悬空调用 → 提示 → idle（带信封）→ prompt 回包 */
  private finish(t: Turn, how: { status: Status; fail?: TurnFailure; synthesized?: true }): void {
    if (t.finished) return;
    t.finished = true;
    for (const x of t.timers) clearTimeout(x);
    this.deps.onFinish?.(t.id);
    for (const u of closeTurn(t.ev, how.status)) this.emitFor(t, u);
    if (how.status === "interrupted") this.droppedSteerNotice(t);
    const stopped = how.status === "interrupted" || t.cancelRequested;
    const fail = stopped ? undefined : how.fail;
    const env = stopped ? { stopReason: "cancelled" } : fail ? { stopReason: "error", failure: envelopeFailure(t.id, fail) } : { stopReason: "end_turn" };
    this.emitFor(t, status("idle", env));
    this.reply(t, stopped, fail);
    this.recent.add(t.id);
    if (this.recent.size > RECENT_MAX) this.recent.delete(this.recent.values().next().value as string);
    if (how.synthesized) this.stale = t;
    if (this.cur === t) this.cur = null;
    this.wake();
  }

  /** 回包都带 usage 和 _meta.quota（2.1.0 同款）；失败结果自己的 _meta（AIR sessionFailure）合在一起 */
  private reply(t: Turn, stopped: boolean, fail?: TurnFailure): void {
    if (!t.ctx) return;
    const usage = this.lastUsage?.epoch === this.deps.session.epoch ? this.lastUsage.last : null;
    const extra = promptUsage(usage, this.deps.policy().model);
    const withUsage = (r: Rec) => ({ ...r, usage: extra.usage, _meta: { ...(extra._meta as Rec), ...(r._meta as Rec | undefined) } });
    if (stopped) return t.ctx.respond(withUsage({ stopReason: "cancelled" }));
    if (!fail) return t.ctx.respond(withUsage({ stopReason: "end_turn" }));
    try {
      t.ctx.respond(withUsage(promptFailureResult(t.id, fail, this.deps.caps().air)));
    } catch (e) {
      t.ctx.fail(e);
    }
  }

  /** B21：叫停时插进来、却一直没被消费的 steer。证据齐（已确认、观测完整、真的 interrupted）才说「已丢弃」 */
  private droppedSteerNotice(t: Turn): void {
    const lost = t.steers.filter((s) => !t.consumed.has(s.clientId));
    if (!lost.length) return;
    const list = lost.map((s) => `「${s.text.slice(0, 40)}」`).join("、");
    const sure = !t.degraded;
    this.emitFor(t, notice(sure ? `叫停时有 ${lost.length} 条插话没被处理，已丢弃，需要的话请重发：${list}` : `叫停时有 ${lost.length} 条插话可能没有执行，请检查后决定是否重发：${list}`));
  }

  private interrupt(t: Turn): void {
    if (t.interruptSent || (t.finished && t !== this.stale)) return;
    t.interruptSent = true;
    const params = { threadId: this.deps.session.current!, turnId: t.id };
    this.deps.app.call("turn/interrupt", params, { timeoutMs: this.t.interruptMs }).catch((e) => this.deps.log(`turn/interrupt ${t.id} 没回（${errText(e)}），只认 turn/completed`));
  }

  /** 终态看门狗（I13）：确认后长时间没有任何事件，探 thread/read；active 继续等，其余按失败收尾，探测失败作废连接 */
  private armWatchdog(t: Turn): void {
    const tick = (): void => {
      if (t.finished) return;
      const quiet = Date.now() - t.lastEventAt;
      if (quiet < this.t.watchdogMs) return void t.timers.push(setTimeout(tick, this.t.watchdogMs - quiet));
      void this.deps.app.call("thread/read", { threadId: this.deps.session.current!, includeTurns: false }).then(
        (r) => {
          if (t.finished) return;
          if (r.thread.status.type === "active") return void ((t.lastEventAt = Date.now()), tick());
          this.finish(t, { status: "failed", fail: { kind: "internal_error", title: `这一轮很久没有动静，app-server 报线程是 ${r.thread.status.type}，按失败收尾` } });
        },
        (e) => void (!t.finished && this.voidConnection(`终态看门狗的 thread/read 失败：${errText(e)}`)),
      );
    };
    t.timers.push(setTimeout(tick, this.t.watchdogMs));
  }

  /** 对账本身出错 = 什么也证明不了：记下来，按查不到处理（结果不明，不重排） */
  private readonly reconcileError = (e: unknown): null => (this.deps.log(`对账出错，按查不到处理：${errText(e)}`), null);

  private emitFor(t: Turn, u: Rec): void {
    if (t.epoch === this.deps.session.epoch) this.deps.emit(u);
  }

  private voidConnection(why: string): void {
    this.deps.log(`作废和 app-server 的连接：${why}`);
    this.deps.fatal({ kind: "protocol", why });
  }

  /** pred 成立（或收尾开始）时兑现；给了 ms 到点还不成立兑现 false */
  private until(pred: () => boolean, ms?: number): Promise<boolean> {
    if (pred()) return Promise.resolve(true);
    if (this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = ms === undefined ? undefined : setTimeout(() => done(false), ms);
      const check = () => (pred() ? done(true) : this.stopped && done(false));
      const done = (v: boolean) => {
        this.waiters.delete(check);
        if (timer) clearTimeout(timer);
        resolve(v);
      };
      this.waiters.add(check);
    });
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }
}
