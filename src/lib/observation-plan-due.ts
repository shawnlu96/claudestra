/**
 * 观察期到期核对与转正（agents-PMAUTO1）。调度 tick 对到期的登记调一次 observationDue（经 `ledger observation-due`），全程在登记文件的锁里：
 * 重核登记人的配置权、规格版本、verified、目标仍在同一 observe 世代，再按证据四条口径判（observation-plan-evidence.ts）。
 * - autoMode off：什么都不做。observe：只在卡上记一条「本会转正 / 本会交 PM」的 note，不切、不通知。on：全过才把指定目标切 on。
 * - 不满足 / 证据缺 / 配置变了：登记转 judged，带证据交 PM 一次，不自动重试；PM 核过可 observation-recheck 放回。
 * 切模式与卡上的 note 不是一笔事务：先落 prepared 回执，再经原 writer 切（恢复策略有自己的审计 / published 对账，autostart 是台账事务），
 * 切成记 published，note 记上才是 noted。中途崩了，重启按回执与审计的 dedupKey 对账，只补 note 不再切；切失败不记成功。
 * tests/observation-plan-due.test.ts。
 */
import type { Database } from "bun:sqlite";
import { setAutostartSwitch } from "./ledger-autostart.js";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import { getEventByDedup, getTask, LedgerError } from "./ledger-store.js";
import { appendEvent, type WriteCtx } from "./ledger-write.js";
import {
  autoMode, lastVerified, OBSERVATION_PLANS_PATH, OBSERVATION_RULE_VERSION, planById, requireConfigurer, targetLabel, targetState, withPlans,
  type ObservationPlan, type PlanEvidence, type PlanPaths, type PlanStore,
} from "./observation-plan.js";
import { evidenceAdapter, evidenceLine, evidenceVerdict, readEvidence, type AdapterPort } from "./observation-plan-evidence.js";
import { setRecovery } from "./recovery-policy.js";
import { projectPm, readSwitch } from "./scheduler-autostart.js";

type Verdict = { code: string; reason: string };
/** 切目标的 writer；guard 在 writer 自己的锁 / 事务里、动手前调，抛错 = 不切。测试注入失败的 writer。 */
interface ObservationWriters {
  recovery(db: Database, plan: ObservationPlan & { target: { kind: "recovery" } }, ctx: Required<Pick<WriteCtx, "now" | "dedupKey">>, guard: () => void, reason: string,
    recoveryPath?: string): Promise<{ event: number | null }>;
  autostart(db: Database, plan: ObservationPlan & { target: { kind: "autostart" } }, ctx: Required<Pick<WriteCtx, "now" | "dedupKey">>, guard: () => void, reason: string): { event: number | null };
}

/**
 * 登记就是登记人对这一次转正的授权：两个原 writer 都以登记人的身份调，由它们各自在锁 / 事务里重核这个人此刻还有没有配置权
 *（换了 PM、被移出名单 → forbidden，不切）。不给调度身份开任何新的写权限。
 */
const observationWriters: ObservationWriters = {
  async recovery(db, plan, ctx, guard, reason, recoveryPath) {
    // guard 经 authorize 在恢复策略文件的锁与台账事务里再跑一遍：等锁期间人工切了 off / 换了授权，这里就不写
    const r = await setRecovery(db, { actor: plan.by, now: ctx.now, dedupKey: ctx.dedupKey }, { project: plan.project, set: { key: plan.target.key, mode: "on" }, reason },
      { ...(recoveryPath ? { path: recoveryPath } : {}), authorize: (d, actor, project) => { guard(); return actorMayConfigure(d, actor, project); } });
    return { event: r.event };
  },
  autostart(db, plan, ctx, guard, reason) {
    return db.transaction(() => {
      const prior = getEventByDedup(db, ctx.dedupKey);
      if (prior) return { event: prior.seq };
      guard();
      const off = readSwitch(db, plan.project).off;
      setAutostartSwitch(db, { actor: plan.by, now: ctx.now, dedupKey: ctx.dedupKey }, { project: plan.project, on: !off, reason, [plan.target.field]: "on" });
      // autostart-set 关着的项目会把「谁、何时、为何关」重盖成这一次；转正只该动那一个字段，同一事务里把原来的关停记录放回去
      if (off) db.prepare("UPDATE meta SET value = json_set(value, '$.off', json(?)) WHERE project = ? AND key = 'autostart'").run(JSON.stringify(off), plan.project);
      return { event: getEventByDedup(db, ctx.dedupKey)?.seq ?? null };
    }).immediate();
  },
};

export interface DueOpts extends PlanPaths {
  adapters?: AdapterPort;
  writers?: Partial<ObservationWriters>;
  /** 只给测试：在指定位置抛错，模拟进程在那里死掉（错误原样冒出去，登记停在当时已落盘的状态） */
  fault?(at: "switched"): void;
}
export type DueOutcome = { plan: ObservationPlan; to: string | null } & (
  | { outcome: "idle"; why: string }
  | { outcome: "dry-run"; wouldPromote: boolean; reason: string }
  | { outcome: "promoted"; text: string }
  | { outcome: "judge"; text: string });

/** 登记之后变了的东西：任何一条都让这条登记作废，不转正。 */
function staleReason(db: Database, plan: ObservationPlan, recoveryPath?: string, authOnly = false): Verdict | null {
  if (!actorMayConfigure(db, plan.by, plan.project)) return { code: "authorization_changed", reason: `登记人 ${plan.by} 现在已无权配置项目 ${plan.project}` };
  if (authOnly) return null;
  if (plan.ruleVersion !== OBSERVATION_RULE_VERSION) return { code: "rule_changed", reason: `核对口径已是 ${OBSERVATION_RULE_VERSION}，登记时是 ${plan.ruleVersion}` };
  const task = getTask(db, plan.taskId);
  if (!task) return { code: "task_missing", reason: `任务 ${plan.taskId} 不在了` };
  if (task.specRev !== plan.specRev) return { code: "spec_changed", reason: `规格已改到 specRev ${task.specRev}，登记时是 ${plan.specRev}` };
  if (lastVerified(db, plan.taskId) !== plan.verifiedAt) return { code: "reverified", reason: "该卡登记后又重新 verified 过，观察要重新登记" };
  const s = targetState(db, plan.project, plan.target, recoveryPath);
  if (s.mode !== "observe") return { code: "mode_changed", reason: `${targetLabel(plan.target)} 现在是 ${s.mode}${s.diagnostic ? `（${s.diagnostic}）` : ""}，不再是 observe` };
  if (s.generation !== plan.generation) return { code: "generation_changed", reason: `${targetLabel(plan.target)} 登记后被改过模式（审计 #${s.generation}），已不是登记时那一段 observe` };
  return null;
}

const promoteKey = (plan: ObservationPlan): string => `observation-promote:${plan.id}:${plan.attempt ?? 0}`;
const judgeText = (plan: ObservationPlan): string =>
  `[观察期核对] ${plan.id} ${plan.taskId} 的 ${targetLabel(plan.target)} 观察 ${plan.hours} 小时到期，没有自动转正：${plan.judge!.reason}。`
  + `证据：${evidenceLine(plan.judge!.evidence)}。请 PM 判断：人工改模式，或处理后 observation-recheck ${plan.id} / 重新 observation-register。`;
const digestText = (plan: ObservationPlan): string =>
  `[观察期转正] ${plan.taskId} ${targetLabel(plan.target)} observe→on（登记 ${plan.id}，卡上 note #${plan.receipt?.note ?? "?"}）`;

class Run {
  constructor(private db: Database, private ctx: WriteCtx & { now: number }, private store: PlanStore, private plan: ObservationPlan, private opts: DueOpts) {}
  private out<T extends object>(o: T) { return { plan: this.plan, to: projectPm(this.db, this.plan.project), ...o }; }
  private idle(why: string): DueOutcome { return this.out({ outcome: "idle" as const, why }); }
  private note(key: string, text: string, data: Record<string, unknown>): number {
    return appendEvent(this.db, { actor: this.ctx.actor, now: this.ctx.now, dedupKey: key }, { project: this.plan.project, target: this.plan.taskId, kind: "note", text, data }).event.seq;
  }

  private judge(v: Verdict, evidence: PlanEvidence | null): DueOutcome {
    this.plan.status = "judged";
    this.plan.judge = { ...v, at: this.ctx.now, evidence };
    this.store.save();
    return this.out({ outcome: "judge" as const, text: judgeText(this.plan) });
  }

  private finish(evidence: PlanEvidence): DueOutcome {
    const p = this.plan, r = p.receipt!;
    r.note = this.note(`observation-note:${p.id}:${p.attempt ?? 0}`,
      `观察期转正：${targetLabel(p.target)} observe→on（登记 ${p.id}，口径 ${p.ruleVersion}；${evidenceLine(evidence)}；审计 #${r.audit ?? "?"}）`,
      { op: "observation_promote", plan: p.id, target: targetLabel(p.target), from: "observe", to: "on", ruleVersion: p.ruleVersion, audit: r.audit ?? null,
        window: { from: evidence.from, to: evidence.to }, source: evidence.source, records: evidence.records.slice(0, 50), recordCount: evidence.records.length });
    r.phase = "noted";
    p.status = "promoted";
    this.store.save();
    return this.out({ outcome: "promoted" as const, text: digestText(p) });
  }

  private async switchTarget(guard: () => void): Promise<number | null> {
    const p = this.plan, w = { ...observationWriters, ...this.opts.writers }, ctx = { now: this.ctx.now, dedupKey: p.receipt!.key };
    const reason = `观察期登记 ${p.id} 到期核对通过，按 ${p.by} 的登记自动转正（卡 ${p.taskId}）`;
    const r = p.target.kind === "recovery" ? await w.recovery(this.db, p as never, ctx, guard, reason, this.opts.recovery) : w.autostart(this.db, p as never, ctx, guard, reason);
    return r.event;
  }

  /** 切 → published → note。切之前任何失败都不留「成功」：没产生审计 = 没切；产生了审计但没生效 = failed，交 PM。 */
  private async promote(evidence: PlanEvidence, replay: boolean): Promise<DueOutcome> {
    const p = this.plan;
    if (!replay) {
      p.receipt = { phase: "prepared", key: promoteKey(p), at: this.ctx.now };
      this.store.save();
    }
    let stale: Verdict | null = null;
    try {
      p.receipt!.audit = await this.switchTarget(() => {
        stale = staleReason(this.db, p, this.opts.recovery, replay);
        if (stale) throw new LedgerError("conflict", stale.reason);
      });
    } catch (e) {
      if (getEventByDedup(this.db, p.receipt!.key) && (e as LedgerError).code === "busy") return this.idle(`转正审计 ${p.receipt!.key} 生没生效还没核定，下一轮对账`);
      const wrote = !!getEventByDedup(this.db, p.receipt!.key);
      if (!wrote && (e as LedgerError).code === "busy") { delete p.receipt; this.store.save(); return this.idle(`目标的写锁被占，这轮没切：${(e as Error).message}`); }
      p.receipt = { ...p.receipt!, phase: "failed", error: (e as Error).message };
      return this.judge(stale ?? { code: "switch_failed", reason: `核对通过但切模式没成，模式仍是原样：${(e as Error).message}` }, evidence);
    }
    this.opts.fault?.("switched");
    p.receipt!.phase = "published";
    this.store.save();
    return this.finish(evidence);
  }

  async run(): Promise<DueOutcome> {
    const p = this.plan, db = this.db;
    if (p.status === "judged") return p.judge?.sentAt ? this.idle("已交 PM") : this.out({ outcome: "judge" as const, text: judgeText(p) });
    if (p.status === "promoted") return p.digestSentAt ? this.idle("已转正") : this.out({ outcome: "promoted" as const, text: digestText(p) });
    if (p.status !== "active") return this.idle(`登记是 ${p.status}`);
    const evidence = readEvidence(db, p, this.ctx.now, this.opts.adapters ?? evidenceAdapter);
    // 上一次停在半路：已切的只补 note；prepared 且审计在 = 让原 writer 按 dedupKey 对账；审计不在 = 没切，照常从头核
    if (p.receipt?.phase === "published") return this.finish(evidence);
    if (p.receipt?.phase === "prepared") {
      if (getEventByDedup(db, p.receipt.key)) return this.promote(evidence, true);
      delete p.receipt;
    }
    const mode = autoMode(db, p.project);
    if (mode === "off") return this.idle("autoMode off");
    if (this.ctx.now < p.dueAt) return this.idle("未到期");
    const verdict = staleReason(db, p, this.opts.recovery) ?? evidenceVerdict(evidence);
    if (mode === "observe") {
      if (p.dryRun) return this.idle("observe：已记过预演");
      const reason = verdict?.reason ?? "四条口径全满足";
      const note = this.note(`observation-dry:${p.id}:${p.attempt ?? 0}`,
        `观察期核对（autoMode observe，未切）：${targetLabel(p.target)} ${verdict ? `本会交 PM 判断：${reason}` : "本会转正"}；${evidenceLine(evidence)}`,
        { op: "observation_dry_run", plan: p.id, target: targetLabel(p.target), wouldPromote: !verdict, code: verdict?.code ?? null });
      p.dryRun = { at: this.ctx.now, wouldPromote: !verdict, reason, note };
      this.store.save();
      return this.out({ outcome: "dry-run" as const, wouldPromote: !verdict, reason });
    }
    return verdict ? this.judge(verdict, evidence) : this.promote(evidence, false);
  }
}

/** 核一条登记；返回要不要、给谁发什么。发出去之后调 ackObservation 记已送，没记上的下一轮原文重发（不重核、不重切）。 */
export async function observationDue(db: Database, ctx: WriteCtx, id: string, opts: DueOpts = {}): Promise<DueOutcome> {
  const c = { ...ctx, now: ctx.now ?? Date.now() };
  return withPlans(opts.plans ?? OBSERVATION_PLANS_PATH, (store) => new Run(db, c, store, planById(store.doc, id), opts).run(), opts.lockMs);
}

export async function ackObservation(now: number, id: string, paths: PlanPaths = {}): Promise<ObservationPlan> {
  return withPlans(paths.plans ?? OBSERVATION_PLANS_PATH, ({ doc, save }) => {
    const p = planById(doc, id);
    if (p.status === "judged" && p.judge && !p.judge.sentAt) p.judge.sentAt = now;
    else if (p.status === "promoted" && !p.digestSentAt) p.digestSentAt = now;
    else return p;
    save();
    return p;
  }, paths.lockMs);
}

/** PM 核过 judged 的登记后放回再核一次（显式、留审计）：清掉判定与失败回执，换一个转正 dedupKey；窗口与绑定不变。 */
export async function recheckObservation(db: Database, ctx: WriteCtx, id: string, reason: string, paths: PlanPaths = {}): Promise<ObservationPlan> {
  return withPlans(paths.plans ?? OBSERVATION_PLANS_PATH, ({ doc, save }) => {
    const p = planById(doc, id);
    requireConfigurer(db, ctx.actor, p.project, "放回观察期登记重核");
    if (p.status !== "judged") throw new LedgerError("conflict", `登记 ${id} 是 ${p.status}，只有已交 PM 判断的能放回重核`);
    const attempt = (p.attempt ?? 0) + 1;
    appendEvent(db, { actor: ctx.actor, now: ctx.now, dedupKey: `observation-plan:${id}:recheck:${attempt}` },
      { project: p.project, target: p.taskId, kind: "decision", text: `观察期登记 ${id} 放回重核：${reason}`, data: { op: "observation_plan", action: "recheck", plan: id, attempt } });
    Object.assign(p, { status: "active", attempt });
    delete p.judge; delete p.receipt; delete p.dryRun;
    save();
    return p;
  }, paths.lockMs);
}
