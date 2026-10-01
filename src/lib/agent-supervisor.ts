/**
 * agent 监护（i28-S1，docs/architecture/agent-supervisor.md）：调度服务每轮 pass 对监护名单（agent-supervisor-scope.ts）里的每个 agent
 * 看一遍，按处置表（agent-supervisor-policy.ts）处置，每一步先在台账认领再动手（agent-supervisor-ledger.ts）。
 * - cyber_policy 截断（bridge 开的「Codex 回合失败」卡，原文是内容策略那句）：同会话发固定恢复消息；同一件活第二次再被拦 → 报派活方；
 * - 宿主或窗口没了 / ACP 回合卡住：两次观察确认（agent-supervisor-judge.ts），动手前再看一眼还是不是那样，重启接回原会话，
 *   起来以后补一句「接着做原来的单」（不重发原单）；每个 agent 每小时最多 2 次，超了报派活方并告诉 owner，这件活不再自动重启；
 * - 撞额度、登录失效：不重启不续跑，owner 的卡照旧由 bridge 开，这里只报派活方（调度单由自动流程退回人工，报 PM 的就是它）。
 * 派活方：调度单 = PM（经 scheduler-fallback-manual 退回人工）；send_to_agent 请求 = 发请求的那个 agent。
 * 失败卡的关闭在 bridge（下一个正常结束的回合，lib/agent-supervisor-bridge.ts）。tests/agent-supervisor*.test.ts。
 */
import type { Database } from "bun:sqlite";
import { listAsks, type Ask } from "./ledger-asks.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { RegistryAgent } from "./registry.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import type { HeldFromLike } from "./held-pac.js";
import type { WorkerLiveness } from "./worker-liveness.js";
import { stuckSince, type ActivityRecord } from "./agent-supervisor-activity.js";
import { TwoStrikes, type Down } from "./agent-supervisor-judge.js";
import { priorAttempts, restartKey, stepState, superviseEvents, type SuperviseEvent, type SuperviseRecord, type SuperviseResult, type SuperviseStep } from "./agent-supervisor-ledger.js";
import { CYBER_RECOVERY_TEXT, SUPERVISE_RULES, decide, isCyberPolicy, RESTART_FAULTS, reportText, restartNudgeText, workKeyOf, type FaultKind } from "./agent-supervisor-policy.js";
import { supervisedAgents, type CallRow, type Supervised } from "./agent-supervisor-scope.js";
import type { OverloadFile } from "./agent-supervisor-bridge.js";

/** 重启后这么久里不再判死判卡住（宿主要起来、会话要接回），只做补发 */
const RESTART_GRACE_MS = 3 * 60_000;
/** 补发「接着做」最多试几次（对方还没登记上 bridge 时投不进去） */
const NUDGE_TRIES = 3;
/** 只看最近这么久的监护事件（重启额度按小时算，cyber 按同一件活） */
const EVENT_LOOKBACK_MS = 24 * 3600_000;

export type SendResult = { ok: true } | { ok: false; delivered: false | "unknown"; reason: string };

export interface SuperviseDeps {
  registry(): RegistryAgent[];
  calls(): CallRow[];
  held(channelId: string): HeldFromLike[] | undefined;
  /** ACP：宿主四态（worker-liveness.ts probeAcpWorker）；tmux：窗口在 = running、不在 = no_window、读不到 = unknown */
  probe(s: Supervised): Promise<WorkerLiveness>;
  activity(agent: string): ActivityRecord | null;
  /** bridge 记的撞错与续跑（agent-supervisor-bridge.ts noteOverload），按频道 */
  overload(): OverloadFile;
  /** 经 `ledger scheduler-supervise` 写一条；duplicate = 已经有人写过（不再动手） */
  record(rec: SuperviseRecord): Promise<{ ok: boolean; duplicate?: boolean; error?: string }>;
  /** 同会话发一条（route_to_agent 带 expectSession） */
  send(agent: string, sessionId: string, text: string): Promise<SendResult>;
  /** 按 registry 重启。expect.eligible() = 前提此刻还成立吗（同步、读最新的 registry 和台账）：生产在拉起 manager 前最后调一次，不成立就不动（skipped） */
  restart(agent: string, expect: RestartExpect): Promise<{ ok: boolean; error?: string; skipped?: string }>;
  /** 调度单退回人工并通知 PM（auto-tick 的 escalate 同一条路） */
  escalate(taskId: string, intentId: string, reason: string): Promise<void>;
  notifyCaller(caller: string, text: string): Promise<void>;
  notifyOwner(channelId: string, text: string): Promise<void>;
  now(): number;
  log(msg: string): void;
}

interface RestartExpect {
  sessionId: string;
  /** null = 还在监护名单里、会话和在途的活都没换；否则是不重启的原因 */
  eligible(): string | null;
}

export interface SuperviseOutcome { agent: string; step: string; detail: string }

/** 这个 agent 还开着的 Codex 运行时卡，新的在前 */
const openCards = (db: Database, agent: string): Ask[] =>
  listAsks(db, { fromAgent: agent, source: "codex", states: ["open"] }).sort((a, b) => b.createdAt - a.createdAt);

const cardFault = (a: Ask): FaultKind | null => {
  if (a.extra.quota === true) return "quota";
  if (a.extra.failure === "error") return isCyberPolicy(`${a.title}\n${a.context}`) ? "cyber" : null;
  return a.kind === "owner_action" ? "auth" : null;
};

/** 一轮监护最多这么频繁（每个 ACP agent 要跑一次 ps）；判死的两次观察间隔、20 分钟的卡住阈值都远大于它 */
const SUPERVISE_EVERY_MS = 30_000;

export class AgentSupervisor {
  private readonly strikes: TwoStrikes;
  private lastRun = -Infinity;

  constructor(private readonly log: (m: string) => void = (m) => console.log(`[supervise] ${m}`)) {
    this.strikes = new TwoStrikes(log);
  }

  /** 一轮：名单里每个 agent 至多处置一件事；某个 agent 出错不挡其余的 */
  async tick(db: Database, config: SchedulerConfig, deps: SuperviseDeps): Promise<{ outcomes: SuperviseOutcome[]; failed: { agent: string; error: string }[] }> {
    const out = { outcomes: [] as SuperviseOutcome[], failed: [] as { agent: string; error: string }[] };
    if (!config.enabled || config.supervise?.enabled !== true) return out;
    if (deps.now() - this.lastRun < SUPERVISE_EVERY_MS) return out;
    this.lastRun = deps.now();
    const list = supervisedAgents({ config, registry: deps.registry(), db, calls: deps.calls(), held: deps.held, now: deps.now() });
    this.strikes.keepOnly(new Set(list.map((s) => s.agent)));
    const stuckMs = config.supervise.stuckMin * 60_000;
    for (const s of list) {
      try {
        const r = await new AgentRound(db, config, s, deps, this.strikes, stuckMs).run();
        if (r) out.outcomes.push({ agent: s.agent, ...r });
      } catch (e) {
        if (e instanceof SchedulerStopped) throw e;
        out.failed.push({ agent: s.agent, error: (e as Error).message.slice(0, 300) });
      }
    }
    return out;
  }
}

type Step = { step: string; detail: string } | null;

class AgentRound {
  private readonly events: SuperviseEvent[];
  private readonly workKey: string;
  /** 重启的去重键在这一轮开始时就定（看到的台账是同一份）：同时开始的两轮算出同一个键，后认领的撞去重 */
  private readonly restartKey: string;

  constructor(readonly db: Database, readonly config: SchedulerConfig, readonly s: Supervised, readonly deps: SuperviseDeps, readonly strikes: TwoStrikes,
    readonly stuckMs: number) {
    this.events = superviseEvents(db, s.agent, deps.now() - EVENT_LOOKBACK_MS);
    this.workKey = workKeyOf(s.work);
    this.restartKey = restartKey(db, s.agent);
  }

  private base(fault: FaultKind, faultKey: string, step: SuperviseStep, attempt: number, limit: number, cardId?: string): Omit<SuperviseRecord, "phase"> {
    const { s } = this;
    return { agent: s.agent, project: s.project, target: s.work.kind === "order" ? s.work.taskId : "", sessionId: s.sessionId, fault, faultKey,
      workKey: this.workKey, step, attempt, limit, ...(cardId ? { cardId } : {}) };
  }

  /** 先认领：没写进台账、或者已经有人写过，都不动手 */
  private async claim(rec: Omit<SuperviseRecord, "phase">): Promise<boolean> {
    const r = await this.deps.record({ ...rec, phase: "claim" });
    if (!r.ok) throw new Error(`监护认领没写进台账：${r.error ?? ""}`);
    return r.duplicate !== true;
  }

  private async done(rec: Omit<SuperviseRecord, "phase">, result: SuperviseResult, detail = ""): Promise<void> {
    const r = await this.deps.record({ ...rec, phase: "done", result, ...(detail ? { detail: detail.slice(0, 600) } : {}) });
    if (!r.ok) this.deps.log(`${this.s.agent} 监护结果没写进台账（认领已在，按做过算）：${r.error ?? ""}`);
  }

  async run(): Promise<Step> {
    const reported = await this.overloads();
    if (reported) return reported;
    const follow = await this.followUpRestart();
    if (follow !== undefined) return follow;
    const card = openCards(this.db, this.s.agent).map((a) => ({ a, f: cardFault(a) })).find((x) => x.f);
    // 额度 / 登录：不重启不续跑（花钱和登录是 owner 的事），连存活也不看
    if (card?.f === "quota" || card?.f === "auth") return this.reportOnce(card.f, card.a.id, card.a);
    // 恢复消息发过了还开着的卡：回合可能又卡住或宿主死了，照常看存活
    return (card?.f === "cyber" ? await this.cyber(card.a) : null) ?? this.liveness();
  }

  /** 内容策略截断：第一次同会话发恢复消息；同一件活再被拦就报派活方 */
  private async cyber(card: Ask): Promise<Step> {
    if (stepState(this.events, card.id, "recover").claim || this.tried(card.id, "report")) return null;
    const d = decide("cyber", priorAttempts(this.events, "cyber", this.workKey, this.deps.now()), card.createdAt, this.deps.now());
    if (d.kind === "report") return this.report("cyber", card.id, d, card.context, card.id);
    if (d.kind === "wait") return null;
    const rec = this.base("cyber", card.id, "recover", d.attempt, d.limit, card.id);
    if (!(await this.claim(rec))) return null;
    // 适配器没给结构化失败时这一轮也被标成能重试，bridge 的 60 秒续跑已经接了：不再发第二套
    if (this.bridgeResumed(card.createdAt)) return await this.done(rec, "skipped", "bridge 的 60 秒续跑已接手"), { step: "recover", detail: "bridge 续跑接手" };
    const sent = await this.deps.send(this.s.agent, this.s.sessionId, CYBER_RECOVERY_TEXT);
    await this.done(rec, sent.ok ? "ok" : sent.delivered === false ? "failed" : "unknown", sent.ok ? "" : sent.reason);
    return { step: "recover", detail: sent.ok ? `第 ${d.attempt} 次恢复消息已发` : `恢复消息没发出去：${sent.reason}` };
  }

  /** 卡开出前后几秒内 bridge 为这个频道记过一次「60 秒后续跑」 */
  private bridgeResumed(at: number): boolean {
    return (this.deps.overload()[this.s.channelId]?.events ?? []).some((e) => e.act === "track" && Math.abs(e.at - at) < 10_000);
  }

  /** 额度 / 登录：卡已由 bridge 开给 owner；调度单的退回人工由自动流程做，这里只给 send_to_agent 的发起方说一声，并留痕一次 */
  private async reportOnce(fault: "quota" | "auth", key: string, card: Ask): Promise<Step> {
    const text = reportText(this.s.agent, this.s.work, fault, { attempts: 0, limit: 0 }, card.title);
    const w = this.s.work;
    // 调度单由自动流程退回人工（报 PM 的就是它），这里只留痕；请求告诉发起方
    return this.tryOnce(key, "report", { fault, attempt: 0, limit: 0, cardId: card.id }, text,
      () => (w.kind === "call" ? this.deps.notifyCaller(w.caller, text) : Promise.resolve()));
  }

  /** 上限用完：报派活方（调度单退回人工、请求告诉发起方）；宿主死 / 卡住另外告诉 owner。同一件活只报一次（发不出去最多再试两次） */
  private async report(fault: FaultKind, faultKey: string, d: { attempts: number; limit: number; advice?: string }, detail: string, cardId?: string): Promise<Step> {
    const text = reportText(this.s.agent, this.s.work, fault, d, detail);
    const w = this.s.work;
    return this.tryOnce(faultKey, "report", { fault, attempt: d.attempts, limit: d.limit, cardId }, text, async () => {
      if (w.kind === "order") await this.deps.escalate(w.taskId, w.intentId, text);
      else await this.deps.notifyCaller(w.caller, text);
      if (RESTART_FAULTS.includes(fault)) await this.deps.notifyOwner(this.s.channelId, text);
    });
  }

  /** 这一步在 baseKey 下的各次尝试（键 = baseKey#n） */
  private tries(baseKey: string, step: SuperviseStep): { claims: SuperviseEvent[]; results: (SuperviseEvent | undefined)[] } {
    const claims = this.events.filter((e) => e.step === step && e.phase === "claim" && e.faultKey.startsWith(`${baseKey}#`));
    return { claims, results: claims.map((c) => stepState(this.events, c.faultKey, step).done) };
  }

  /** 做过了（成了，或者认领了却不知道结果）就不再做 */
  private tried(baseKey: string, step: SuperviseStep): boolean {
    const { results } = this.tries(baseKey, step);
    return results.some((r) => !r || r.result !== "failed");
  }

  /**
   * 只做一次的动作（报派活方、补发接着做）：确定没成（failed）才在新键上再试，最多 NUDGE_TRIES 次；认领了没结果 = 不知道做没做，不再做。
   * 动作抛错记 failed，下一轮重试。
   */
  private async tryOnce(baseKey: string, step: SuperviseStep, f: { fault: FaultKind; attempt: number; limit: number; cardId?: string }, what: string,
    act: () => Promise<SendResult | void>): Promise<Step> {
    const { claims } = this.tries(baseKey, step);
    if (this.tried(baseKey, step) || claims.length >= NUDGE_TRIES) return null;
    const rec = this.base(f.fault, `${baseKey}#${claims.length + 1}`, step, f.attempt, f.limit, f.cardId);
    if (!(await this.claim(rec))) return null;
    let r: SendResult | void;
    try {
      r = await act();
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      r = { ok: false, delivered: false, reason: (e as Error).message };
    }
    const result: SuperviseResult = !r || r.ok ? "ok" : r.delivered === false ? "failed" : "unknown";
    await this.done(rec, result, r && !r.ok ? r.reason : what);
    return { step, detail: r && !r.ok ? `${what}（没成：${r.reason}）` : what };
  }

  /**
   * 满载 / 限流 / 5xx：续跑由 bridge 的 60 秒续跑做（同一串最多 3 次，agent-supervisor-bridge.ts），这里把每次撞错和处理补进台账；
   * bridge 说续跑用完了（escalate）→ 报派活方，同一次只报一次。
   */
  private async overloads(): Promise<Step> {
    const since = this.deps.now() - EVENT_LOOKBACK_MS;
    let n = this.events.filter((x) => x.fault === "overload" && x.step === "resume" && x.workKey === this.workKey).length;
    for (const e of (this.deps.overload()[this.s.channelId]?.events ?? []).filter((x) => x.at >= since)) {
      const key = `overload:${this.s.agent}:${e.at}`;
      const workReport = `overload:${this.s.agent}:${this.workKey}`; // 用完以后每次撞都是 escalate：同一件活只报一次
      if (e.act === "track" && !stepState(this.events, key, "resume").done) {
        const rec = this.base("overload", key, "resume", ++n, SUPERVISE_RULES.overload.limit);
        await this.done(rec, "ok", `bridge 60 秒后同会话续跑：${e.error}`);
      } else if (e.act === "escalate" && !this.tried(workReport, "report")) {
        const d = { attempts: SUPERVISE_RULES.overload.limit, limit: SUPERVISE_RULES.overload.limit };
        const step = await this.report("overload", workReport, d, e.error);
        if (step) return step;
      }
    }
    return null;
  }

  /** 这件活已经因为重启额度用完报过了：不再自动重启（交给派活方 / owner），免得每小时两次一直重启下去 */
  private handsOff(): boolean {
    return this.events.some((e) => e.step === "report" && e.workKey === this.workKey && RESTART_FAULTS.includes(e.fault));
  }

  private async look(): Promise<{ liveness: WorkerLiveness; stuckSince: number | null }> {
    const liveness = await this.deps.probe(this.s);
    const since = this.s.transport === "acp" ? stuckSince(this.deps.activity(this.s.agent), this.s.sessionId, this.deps.now(), this.stuckMs) : null;
    return { liveness, stuckSince: since };
  }

  private async liveness(): Promise<Step> {
    if (this.handsOff()) return null;
    const id = { agent: this.s.agent, sessionId: this.s.sessionId, workKey: this.workKey };
    const down = this.strikes.note(id, await this.look(), this.deps.now());
    return down ? this.revive(down) : null;
  }

  private async revive(down: Down): Promise<Step> {
    const fault: FaultKind = down === "stuck" ? "stuck" : "dead";
    const now = this.deps.now();
    const d = decide(fault, priorAttempts(this.events, fault, this.workKey, now), now, now);
    if (d.kind === "report") return this.report(fault, `${fault}:${this.s.agent}:${this.workKey}`, d, down);
    if (d.kind === "wait") return { step: "wait", detail: `${down}，重启退避到 ${new Date(d.untilMs).toISOString()}` };
    // 判定和动手之间可能恢复了：认领前看一眼（省得白占额度），认领后再核一遍（认领要等台账写完）
    const pre = await this.stillDown(down);
    if (pre) return { step: "recovered", detail: `${pre}，不重启` };
    const rec = this.base(fault, this.restartKey, "restart", d.attempt, d.limit);
    if (!(await this.claim(rec))) return null;
    const late = await this.stillDown(down);
    const r = late ? { ok: false, skipped: late } : await this.deps.restart(this.s.agent, { sessionId: this.s.sessionId, eligible: () => this.eligible(down) });
    if (r.skipped) return await this.done(rec, "skipped", r.skipped), { step: "recovered", detail: `${r.skipped}，不重启` };
    await this.done(rec, r.ok ? "ok" : "failed", r.ok ? down : `${down}；${r.error ?? ""}`);
    return { step: "restart", detail: r.ok ? `${down} → 已重启（第 ${d.attempt}/${d.limit} 次）` : `重启失败：${r.error ?? ""}` };
  }

  /**
   * 重启的前提此刻还成立吗（null = 成立）：还是同一种否定，并且（探活之后再看，探活本身要等）还在监护名单里、会话和活没换
   * （PM 换会话、活交了 / 退回人工都算换）。tests/agent-supervisor-e2e.test.ts「认领期间恢复 / 换会话 / 活交了」。
   */
  private async stillDown(down: Down): Promise<string | null> {
    const again = await this.look();
    const still = down === "stuck" ? again.liveness === "running" && again.stuckSince !== null : again.liveness === down;
    return still ? this.eligible(down) : `${down} 确认后又恢复了（${again.liveness}）`;
  }

  /** 同步读最新的 registry、回程簿和台账：这件活、这个会话还在监护名单里吗 */
  private eligible(down: Down): string | null {
    const now = this.deps.now();
    const s = supervisedAgents({ config: this.config, registry: this.deps.registry(), db: this.db, calls: this.deps.calls(), held: this.deps.held, now })
      .find((x) => x.agent === this.s.agent);
    return s && s.sessionId === this.s.sessionId && workKeyOf(s.work) === this.workKey ? null : `${down} 确认后不在监护范围了（会话或在途的活变了）`;
  }

  /**
   * 最近一次重启的善后：宽限期内不判死判卡住；重启成功、会话接回、宿主在跑，就补一句「接着做」（每次重启只发一次，
   * 投不进去最多再试 NUDGE_TRIES 次；认领了没结果 = 不知道发没发，不再发）。返回 undefined = 不在善后里，照常往下看。
   */
  private async followUpRestart(): Promise<Step | undefined> {
    const last = this.events.filter((e) => e.step === "restart" && e.phase === "claim").at(-1);
    const now = this.deps.now();
    if (!last || now - last.ts >= RESTART_GRACE_MS * 3) return undefined;
    const graced = now - last.ts < RESTART_GRACE_MS;
    const quiet = graced ? null : undefined;
    const done = stepState(this.events, last.faultKey, "restart").done;
    if (done?.result === "skipped") return undefined; // 认领了但核下来不用重启：没有善后
    if (done?.result !== "ok" || last.workKey !== this.workKey || this.tried(last.faultKey, "nudge")) return quiet;
    if ((await this.deps.probe(this.s)) !== "running") return quiet;
    const text = restartNudgeText(this.s.work, last.fault === "stuck" ? "stuck" : "dead");
    const step = await this.tryOnce(last.faultKey, "nudge", { fault: last.fault, attempt: last.attempt, limit: last.limit }, "重启后已补发「接着做」",
      () => this.deps.send(this.s.agent, this.s.sessionId, text));
    return step ?? quiet;
  }
}
