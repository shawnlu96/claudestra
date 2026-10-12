/**
 * 观察期登记（agents-PMAUTO1）：PM / master / owner 对「某张卡上线后、某个机制观察满 N 小时就从 observe 切 on」这一个具体动作的授权。
 * 登记落状态目录 observation-plans.json（file-lock + 原子写），不往严格的 recovery-policy.json 塞字段；恢复策略 / autostart 仍是模式真源。
 * 目标只认白名单：项目级恢复单键（manualStall 除外）与 autostart 的三档单字段；整机键、manualStallHours、额度线、阈值是 owner 的，拒登记。
 * 一条登记绑定：规格版本、该卡最近一次 verified、目标当时所在的 observe 世代（最近一次改变它生效模式的审计 seq）与登记人的配置权；
 * 到期重核任何一项变了都不转正（observation-plan-due.ts）。人工误判标记与撤销都持久在本文件，重启不丢。
 * docs/architecture/observation-plan.md；tests/observation-plan*.test.ts。
 */
import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { acquireLock, type LockHandle } from "./file-lock.js";
import { actorMayConfigure, textOneLine } from "./ledger-scheduler-settle.js";
import { getEventByDedup, getTask, LedgerError } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";
import { appendEvent, type WriteCtx } from "./ledger-write.js";
import { statePath } from "./paths.js";
import { MACHINE_RECOVERY_KEYS } from "./recovery-machine-policy.js";
import { RECOVERY_KEYS, RECOVERY_POLICY_PATH, recoveryPolicy, recoveryVoidKey, type RecoveryKey } from "./recovery-policy.js";
import { readSwitch } from "./scheduler-autostart.js";
import { parseObservation } from "./scheduler-post-verify-defer.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";

export const OBSERVATION_PLANS_PATH = statePath("observation-plans.json");
/** 核对口径版本：登记时写明，口径改了旧登记到期不认（要重新登记）。 */
export const OBSERVATION_RULE_VERSION = "v1";
/** 首版唯一的样本来源：台账里的结构化事件。 */
export const OBSERVATION_SOURCE = "ledger-events";
const HOUR_MS = 3_600_000;

export type AutoMode = "on" | "observe" | "off";
/** autostart 里能自动转正的三档单字段；autoMode / p2BacklogMode 自己不在内（本机制不给自己转正），额度线与阈值是 owner 的数。 */
export const AUTOSTART_TARGET_FIELDS = ["mergePmWait", "postVerifyDefer", "reviewPmWait", "specWait", "wipGate"] as const;
export type AutostartTargetField = (typeof AUTOSTART_TARGET_FIELDS)[number];
export type ObservationTarget = { kind: "recovery"; key: RecoveryKey } | { kind: "autostart"; field: AutostartTargetField };
export const targetLabel = (t: ObservationTarget): string => (t.kind === "recovery" ? `recovery:${t.key}` : `autostart:${t.field}`);

/** 项目级独立开关 autostart.autoMode（缺省 observe）：off 不核、observe 只记本会怎样、on 才执行。 */
export const autoMode = (db: Database, project: string): AutoMode => {
  const v = readSwitch(db, project).autoMode;
  return v === "on" || v === "off" ? v : "observe";
};

export interface Misjudged { record: number; reason: string; by: string; at: number; cleared?: { by: string; at: number; reason: string } }
export interface PlanEvidence { from: number; to: number; source: string; records: number[]; errors: number[]; misjudged: number[]; complete: boolean; why?: string }
export interface PlanJudge { code: string; reason: string; at: number; evidence: PlanEvidence | null; sentAt?: number }
/** 执行回执：prepared 先落盘再切，published = 模式已切（audit = 审计事件 seq），noted = 卡上的 note 也记了。 */
export interface PlanReceipt { phase: "prepared" | "published" | "noted" | "failed"; key: string; at: number; audit?: number | null; note?: number; error?: string }
export interface ObservationPlan {
  id: string;
  taskId: string;
  project: string;
  target: ObservationTarget;
  hours: number;
  startAt: number;
  dueAt: number;
  ruleVersion: string;
  source: string;
  specRev: number;
  verifiedAt: number;
  /** 起始 observe 世代：最近一次改变目标生效模式的审计事件 seq；0 = 一直是缺省 observe */
  generation: number;
  by: string;
  at: number;
  reason: string;
  status: "active" | "cancelled" | "promoted" | "judged";
  misjudged: Misjudged[];
  cancelled?: { by: string; at: number; reason: string };
  /** observe 档只记一次的预演结论 */
  dryRun?: { at: number; wouldPromote: boolean; reason: string; note: number };
  /** observation-recheck 放回的次数：转正 / note 的 dedupKey 带它，放回后不撞上一次作废的审计 */
  attempt?: number;
  receipt?: PlanReceipt;
  judge?: PlanJudge;
  /** 转正成功的一行摘要是否已送达 */
  digestSentAt?: number;
}
export interface PlansDoc { v: 1; seq: number; plans: ObservationPlan[] }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const validDoc = (d: unknown): boolean => isObj(d) && d.v === 1 && Number.isSafeInteger(d.seq) && Array.isArray(d.plans)
  && d.plans.every((p) => isObj(p) && typeof p.id === "string" && typeof p.taskId === "string" && typeof p.project === "string" && isObj(p.target)
    && Number.isFinite(p.startAt) && Number.isFinite(p.dueAt) && typeof p.status === "string" && Array.isArray(p.misjudged));

/** 不拿锁的只读快照；文件坏了抛 invalid（不当成空：坏文件上不能再登记，也不能当「没有误判标记」）。 */
export function readPlans(path = OBSERVATION_PLANS_PATH): PlansDoc {
  const r = readJsonStateSync(path, validDoc);
  if (r.status === "corrupt") throw new LedgerError("invalid", `${path} 坏了（${r.error}），观察期登记读不了；没动，先手动修好`);
  return r.status === "ok" ? (r.data as PlansDoc) : { v: 1, seq: 0, plans: [] };
}

export const planById = (doc: PlansDoc, id: string): ObservationPlan => {
  const p = doc.plans.find((x) => x.id === id);
  if (!p) throw new LedgerError("not_found", `没有观察期登记 ${id}`);
  return p;
};

export interface PlanStore { doc: PlansDoc; save(): void; lock: LockHandle }
/**
 * 锁内读 → fn 改 → 调 save() 原子写（锁已被回收就不提交）。登记、撤销、标误判与到期核对都经这里串行，
 * 所以人工先到的 off / 误判标记，到期核对一定看得见；fn 里可以多次 save（回执分阶段落盘）。
 */
export async function withPlans<T>(path: string, fn: (s: PlanStore) => Promise<T> | T, lockMs = 10_000): Promise<T> {
  mkdirSync(dirname(path), { recursive: true });
  const lock = await acquireLock(`${path}.lock`, lockMs);
  if (!lock) throw new LedgerError("busy", `${path} 正被别的进程占着（${Math.round(lockMs / 1000)} 秒没拿到锁），这次没改，稍后重试`);
  try {
    const doc = readPlans(path);
    const save = (): void => {
      try { writeJsonAtomicSync(path, doc, { trailingNewline: true, commitIf: lock.held }); }
      catch (e) {
        if (!lock.held()) throw new LedgerError("busy", `提交前发现 ${path} 的锁已被别人回收，这次没写，重试即可`);
        throw e;
      }
    };
    return await fn({ doc, save, lock });
  } finally {
    lock.release();
  }
}

/** `recovery:<恢复键>` / `autostart:<字段>`；owner 专属与整机目标给出各自的拒绝理由。 */
export function parseTarget(raw: string | undefined): ObservationTarget {
  const m = /^(recovery|autostart):([A-Za-z]\w{0,40})$/.exec(raw ?? "");
  if (!m) throw new LedgerError("invalid", "--target 要写 recovery:<恢复键> 或 autostart:<字段>");
  const [, kind, name] = m as unknown as [string, "recovery" | "autostart", string];
  if (kind === "recovery") {
    if ((MACHINE_RECOVERY_KEYS as readonly string[]).includes(name)) throw new LedgerError("forbidden", `${name} 是整机恢复键，只有 owner / master 人工改，不自动转正`);
    if (name === "manualStall" || name === "manualStallHours") throw new LedgerError("forbidden", `${name} 跟 owner 定的 manualStallHours 绑在一起，不自动转正`);
    if (!(RECOVERY_KEYS as readonly string[]).includes(name)) throw new LedgerError("invalid", `未知恢复键 ${name}`);
    return { kind, key: name as RecoveryKey };
  }
  if (["weeklyLinePct", "codexWeeklyLinePct", "wipGateThreshold", "off", "features"].includes(name)) {
    throw new LedgerError("forbidden", `autostart.${name} 是额度线 / 阈值 / 总开关，owner 或 PM 人工定，不自动转正`);
  }
  if (name === "autoMode" || name === "p2BacklogMode") throw new LedgerError("forbidden", `autostart.${name} 不能由观察期登记给自己转正，PM 核过后人工开`);
  if (!(AUTOSTART_TARGET_FIELDS as readonly string[]).includes(name)) throw new LedgerError("invalid", `autostart 能登记的字段只有 ${AUTOSTART_TARGET_FIELDS.join(" / ")}`);
  return { kind, field: name as AutostartTargetField };
}

export interface TargetState { mode: AutoMode; generation: number; since: number; diagnostic?: string }
type AuditRow = { seq: number; ts: number; data: string };

/** 目标此刻的生效模式，以及它所在世代（最近一次改变其生效模式、且没作废的审计）。恢复键读文件，autostart 读台账 meta。 */
export function targetState(db: Database, project: string, t: ObservationTarget, recoveryPath = RECOVERY_POLICY_PATH): TargetState {
  if (t.kind === "recovery") {
    const p = recoveryPolicy(project, t.key, recoveryPath);
    const rows = db.prepare("SELECT seq, ts, data FROM events WHERE project = ? AND kind = 'decision' AND json_extract(data, '$.op') = 'scheduler_recovery' ORDER BY seq DESC")
      .all(project) as AuditRow[];
    type S = { mode?: string | null; keys?: Record<string, string> };
    const eff = (s: S | undefined): string => s?.keys?.[t.key] ?? s?.mode ?? "observe";
    const hit = rows.find((r) => {
      const d = JSON.parse(r.data) as { from?: S; to?: S };
      return eff(d.from) !== eff(d.to) && !getEventByDedup(db, recoveryVoidKey(r.seq));
    });
    return { mode: p.mode, generation: hit?.seq ?? 0, since: hit?.ts ?? 0, ...(p.diagnostic ? { diagnostic: p.diagnostic } : {}) };
  }
  const rows = db.prepare("SELECT seq, ts, data FROM events WHERE project = ? AND kind = 'meta' AND json_extract(data, '$.op') = 'autostart' ORDER BY seq").all(project) as AuditRow[];
  let prev = "observe", generation = 0, since = 0;
  for (const r of rows) {
    const cur = String((JSON.parse(r.data) as { value?: Record<string, unknown> }).value?.[t.field] ?? "observe");
    if (cur !== prev) [prev, generation, since] = [cur, r.seq, r.ts];
  }
  const now = (readSwitch(db, project) as Record<string, unknown>)[t.field] ?? "observe";
  return now === "on" || now === "off" || now === "observe" ? { mode: now, generation, since } : { mode: "off", generation, since, diagnostic: `autostart.${t.field} 的值认不出` };
}

/** 卡最近一次进 verified 的 stage 事件时间；没有这条事件 = 没上线过，不能登记。 */
export function lastVerified(db: Database, taskId: string): number | null {
  const r = db.query("SELECT ts FROM events WHERE target = ? AND kind = 'stage' AND json_extract(data, '$.to') = 'verified' ORDER BY seq DESC LIMIT 1").get(taskId) as { ts: number } | null;
  return r?.ts ?? null;
}

const FORBIDDEN = (actor: string, project: string, what: string) =>
  new LedgerError("forbidden", `${what}要项目 ${project} 的 PM（调度助理除外）/ master / owner（你是 ${actor}）`);
/** 登记 / 撤销 / 标误判 / 清标记的同一条权限：有权改该项目调度开关的人。 */
export function requireConfigurer(db: Database, actor: string, project: string, what: string): void {
  if (!actorMayConfigure(db, actor, project)) throw FORBIDDEN(actor, project, what);
}

const OP = "observation_plan";
/** 每个登记动作在卡上留一条 decision；dedup 按登记号 + 动作 + 序号，重放不重复。 */
function audit(db: Database, ctx: WriteCtx, plan: ObservationPlan, action: string, n: number, text: string, data: Record<string, unknown> = {}): number {
  return appendEvent(db, { actor: ctx.actor, now: ctx.now, dedupKey: `observation-plan:${plan.id}:${action}:${n}` },
    { project: plan.project, target: plan.taskId, kind: "decision", text, data: { op: OP, action, plan: plan.id, target: targetLabel(plan.target), ...data } }).event.seq;
}

/** 时长复用 PVDEFER1 的格式与 168 小时封顶：--hours 与规格「观察期：N 小时」走同一个解析。 */
export function observationHours(hoursFlag: string | undefined, section: string | null): number {
  const o = parseObservation(hoursFlag === undefined ? section : `观察期：${hoursFlag} 小时`);
  if (o === null || o === "bad") {
    throw new LedgerError("invalid", hoursFlag === undefined ? "规格「## 上线后 PM」第一行没写能认的「观察期：N 小时」，用 --hours <1 以上整数> 明确给" : `--hours 要是 1 以上的整数（超过 168 按 168 算），收到 ${hoursFlag}`);
  }
  return o.hours;
}

export interface RegisterInput {
  taskId: string; project: string; target: ObservationTarget; hours: number; ruleVersion: string; source: string; reason: string;
  /** 不给 = 该卡最近一次 verified */
  startAt?: number;
}
export interface PlanPaths { plans?: string; recovery?: string; lockMs?: number }

function checkRegister(db: Database, ctx: WriteCtx, input: RegisterInput, now: number, recoveryPath: string | undefined):
  { task: LedgerTask; verifiedAt: number; state: TargetState; startAt: number } {
  requireConfigurer(db, ctx.actor, input.project, "登记观察期");
  const task = getTask(db, input.taskId);
  if (!task) throw new LedgerError("not_found", `没有任务 ${input.taskId}`);
  if (task.project !== input.project) throw new LedgerError("invalid", `任务 ${task.id} 属于项目 ${task.project}，不是 ${input.project}`);
  if (input.ruleVersion !== OBSERVATION_RULE_VERSION) throw new LedgerError("invalid", `--rule 现在只有 ${OBSERVATION_RULE_VERSION}（核对口径版本），收到 ${input.ruleVersion}`);
  if (input.source !== OBSERVATION_SOURCE) throw new LedgerError("invalid", `--source 现在只有 ${OBSERVATION_SOURCE}（台账结构化事件），收到 ${input.source}`);
  const verifiedAt = lastVerified(db, task.id);
  if (task.stage !== "verified" || verifiedAt === null) throw new LedgerError("invalid", `任务 ${task.id} 不在 verified（现在 ${task.stage}），上线后才能登记观察期`);
  const state = targetState(db, input.project, input.target, recoveryPath);
  if (state.mode !== "observe") throw new LedgerError("invalid", `${targetLabel(input.target)} 现在是 ${state.mode}${state.diagnostic ? `（${state.diagnostic}）` : ""}，只有 observe 中的机制能登记转正`);
  const startAt = input.startAt ?? verifiedAt;
  if (!Number.isSafeInteger(startAt) || startAt > now) throw new LedgerError("invalid", "观察起点不能晚于现在");
  // 不倒填：起点不早于这次上线，也不早于本 observe 世代开始；更早的那段没有可核的完整证据
  if (startAt < verifiedAt) throw new LedgerError("invalid", "观察起点不能早于该卡最近一次 verified（不倒填上线前的观察）");
  if (startAt < state.since) throw new LedgerError("invalid", `观察起点早于 ${targetLabel(input.target)} 本次进 observe 的时间（审计 #${state.generation}），不倒填`);
  return { task, verifiedAt, state, startAt };
}

/** 登记一条自动转正授权。同一项目同一目标只留一条有效登记：重新上线 / 改规则先 observation-cancel 再登记。 */
export async function registerObservation(db: Database, ctx: WriteCtx, input: RegisterInput, paths: PlanPaths = {}): Promise<ObservationPlan> {
  const now = ctx.now ?? Date.now(), reason = textOneLine(input.reason, "原因", 600);
  checkRegister(db, ctx, input, now, paths.recovery);
  return withPlans(paths.plans ?? OBSERVATION_PLANS_PATH, ({ doc, save }) => {
    const { task, verifiedAt, state, startAt } = checkRegister(db, ctx, input, now, paths.recovery); // 等锁期间权限 / 模式可能已变
    const dup = doc.plans.find((p) => p.status === "active" && p.project === input.project && targetLabel(p.target) === targetLabel(input.target));
    if (dup) throw new LedgerError("conflict", `${targetLabel(input.target)} 已有有效登记 ${dup.id}（卡 ${dup.taskId}），要改先 observation-cancel ${dup.id}`);
    const plan: ObservationPlan = { id: `obs-${doc.seq + 1}`, taskId: task.id, project: input.project, target: input.target, hours: input.hours, startAt,
      dueAt: startAt + input.hours * HOUR_MS, ruleVersion: input.ruleVersion, source: input.source, specRev: task.specRev, verifiedAt, generation: state.generation,
      by: ctx.actor, at: now, reason, status: "active", misjudged: [] };
    audit(db, ctx, plan, "register", 0, `观察期登记 ${plan.id}：${targetLabel(plan.target)} 观察 ${plan.hours} 小时后自动转正（${reason}）`,
      { hours: plan.hours, startAt, dueAt: plan.dueAt, ruleVersion: plan.ruleVersion, source: plan.source, specRev: plan.specRev, generation: plan.generation });
    doc.seq += 1;
    doc.plans.push(plan);
    save();
    return plan;
  }, paths.lockMs);
}

/** 撤掉自动转正；已转正 / 已判过的登记不再变。 */
export async function cancelObservation(db: Database, ctx: WriteCtx, id: string, reasonRaw: string, paths: PlanPaths = {}): Promise<ObservationPlan> {
  const reason = textOneLine(reasonRaw, "原因", 600);
  return withPlans(paths.plans ?? OBSERVATION_PLANS_PATH, ({ doc, save }) => {
    const plan = planById(doc, id);
    requireConfigurer(db, ctx.actor, plan.project, "撤销观察期登记");
    if (plan.status !== "active") throw new LedgerError("conflict", `登记 ${id} 已是 ${plan.status}，撤不了`);
    if (plan.receipt && plan.receipt.phase !== "failed") throw new LedgerError("conflict", `登记 ${id} 正在转正（回执 ${plan.receipt.phase}），撤不了；要关该机制用它自己的开关`);
    audit(db, ctx, plan, "cancel", 0, `观察期登记 ${id} 撤销，不再自动转正：${reason}`);
    plan.status = "cancelled";
    plan.cancelled = { by: ctx.actor, at: ctx.now ?? Date.now(), reason };
    save();
    return plan;
  }, paths.lockMs);
}

/**
 * 人工标误判 / 清标记。标记持久在登记里，到期核对只要有一条没清的就不转正；清除是另一条显式命令，各留一条审计。
 * record 必须是本项目台账里的事件号（观察记录号），免得标到别的项目或不存在的记录上。
 */
export async function markObservation(db: Database, ctx: WriteCtx, input: { id: string; record: number; reason: string; clear?: boolean },
  paths: PlanPaths = {}): Promise<ObservationPlan> {
  const reason = textOneLine(input.reason, "理由", 600), now = ctx.now ?? Date.now();
  if (!Number.isSafeInteger(input.record) || input.record < 1) throw new LedgerError("invalid", "--misjudged 要给观察记录号（台账事件 seq，正整数）");
  return withPlans(paths.plans ?? OBSERVATION_PLANS_PATH, ({ doc, save }) => {
    const plan = planById(doc, input.id);
    requireConfigurer(db, ctx.actor, plan.project, input.clear ? "清误判标记" : "标误判");
    if (plan.status !== "active") throw new LedgerError("conflict", `登记 ${plan.id} 已是 ${plan.status}，标记不再影响它`);
    const live = plan.misjudged.find((m) => m.record === input.record && !m.cleared);
    if (input.clear) {
      if (!live) throw new LedgerError("not_found", `登记 ${plan.id} 上没有记录 #${input.record} 的未清误判标记`);
      audit(db, ctx, plan, "unmark", plan.misjudged.indexOf(live), `观察期登记 ${plan.id} 清掉记录 #${input.record} 的误判标记：${reason}`, { record: input.record });
      live.cleared = { by: ctx.actor, at: now, reason };
    } else {
      if (live) return plan;
      const ev = db.query("SELECT project FROM events WHERE seq = ?").get(input.record) as { project: string } | null;
      if (ev?.project !== plan.project) throw new LedgerError("not_found", `项目 ${plan.project} 的台账里没有事件 #${input.record}`);
      audit(db, ctx, plan, "mark", plan.misjudged.length, `观察期登记 ${plan.id} 标记录 #${input.record} 为误判：${reason}`, { record: input.record });
      plan.misjudged.push({ record: input.record, reason, by: ctx.actor, at: now });
    }
    save();
    return plan;
  }, paths.lockMs);
}
