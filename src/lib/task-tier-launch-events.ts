/**
 * 类型模型选择的启动事实（TIER3）：每次建会话尝试一条 attempt（角色、类型、家族、轮次、启动标识、建议值、最终参数及来源），
 * 建失败另记 failed 并留原因（失败单列，不和成功混），等到 session id 再记 bound 把这次尝试绑到会话上。都是项目级 note 事件（台账入口
 * appendEvent，target ""、data.card = 卡号：卡自己的流程事件流一字不变；dedup = 启动标识 + 阶段，重放不重记）。actual 沿用 TIER1b 的
 * ModelActualRecord：运行时没证实的一律 unknown，不拿 argv 或默认冒充实际。taskTierLaunchHistory 读事件本身，开关后来改 off 也照样读得到。
 * tests/task-tier-launch-events.test.ts。
 */
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { LedgerEvent } from "./ledger-stages.js";
import { getTask, listEvents, openLedger } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import type { ModelActualRecord } from "./lend-wire-types.js";

export const TIER_LAUNCH_OP = "task_tier_launch";
const UNKNOWN: ModelActualRecord = { model: null, effort: null, source: "unknown" };

/** 一次建会话尝试：suggested = 类型解析出的值；final = 实际交给 create 的 --model / --effort（没带 = null） */
export interface LaunchPlan {
  project: string;
  card: string;
  role: string;
  tier: string;
  family: "claude" | "codex";
  round: number;
  launchId: string;
  agent: string | null;
  suggested: string | null;
  final: { model: string | null; effort: string | null };
  /** 最终值来自哪：explicit / override / tier-settings / tier-default / role-settings / role-default */
  source: string;
  note?: string;
}

export const newLaunchId = (card: string, role: string, round: number): string => `${card}:${role}:r${round}:${randomUUID().slice(0, 8)}`;
/**
 * 调度器手里的台账连接是只读的（它的流程写经 scheduler 身份的 ledger CLI）；启动事实与 TIER1 的 would-use 一样走同一文件的可写连接
 * （openLedger 按路径缓存，本来就是它开的就是同一个）。内存库没有路径，只能用它自己。
 */
export const ledgerWriter = (db: Database): Database => db.filename && db.filename !== ":memory:" ? openLedger(db.filename) : db;

/** 卡不在本台账（测试替身、远端卡）就不记：启动事实只挂在真有这张卡的台账上 */
function put(reader: Database, plan: Pick<LaunchPlan, "project" | "card" | "launchId">, phase: string, text: string, data: Record<string, unknown>, now: number): boolean {
  const db = ledgerWriter(reader);
  if (getTask(db, plan.card)?.project !== plan.project) return false;
  const r = appendEvent(db, { actor: "scheduler", now, dedupKey: `task-tier-launch:${plan.launchId}:${phase}` },
    { project: plan.project, target: "", kind: "note", text: text.slice(0, 600), data: { op: TIER_LAUNCH_OP, phase, card: plan.card, launchId: plan.launchId, ...data } });
  return !r.duplicate;
}
const finalText = (p: LaunchPlan) => p.family === "claude" ? (p.final.model ?? "定义文件模型") : (p.final.effort ?? "Codex 自己的配置");
const stillOpen = (db: Database, plan: LaunchPlan) => taskTierLaunchHistory(ledgerWriter(db), plan.project, plan.card).find((f) => f.plan.launchId === plan.launchId)?.status === "attempted";

export function recordLaunchAttempt(db: Database, plan: LaunchPlan, now = Date.now()): boolean {
  return put(db, plan, "attempt", `类型模型：${plan.card} ${plan.role}（${plan.tier} / ${plan.family} / 第 ${plan.round} 轮）启动用 ${finalText(plan)}（来源 ${plan.source}）`,
    { plan }, now);
}

/** 只对还在 attempted 的尝试记：已失败 / 已绑定的不翻案 */
export function recordLaunchFailed(db: Database, plan: LaunchPlan, reason: string, now = Date.now()): boolean {
  if (!stillOpen(db, plan)) return false;
  return put(db, plan, "failed", `类型模型：${plan.card} ${plan.role} 这次启动没建成：${reason}`, { reason: reason.slice(0, 400) }, now);
}

/**
 * 这张卡这个角色、这个 agent 最近一次还没绑定也没失败的尝试，绑到会话上。actual 不给 = unknown（运行时没证实）。
 * 没有可绑的尝试（开关 off 时建的、或已绑过）返回 false，不补记。
 */
export function bindLaunchSession(reader: Database, o: { project: string; card: string; role: string; agent: string; sessionId: string; actual?: ModelActualRecord },
  now = Date.now()): boolean {
  const db = ledgerWriter(reader);
  // create 的名字和 registry 里的全名可能差一层 agent- 前缀（manager normalizeName），比较时都去掉
  const bare = (n: string | null) => (n ?? "").replace(/^agent-/, "");
  const open = taskTierLaunchHistory(db, o.project, o.card).findLast((f) => f.plan.role === o.role && bare(f.plan.agent) === bare(o.agent) && f.status === "attempted");
  if (!open) return false;
  const actual = o.actual ?? UNKNOWN;
  return put(db, open.plan, "bound", `类型模型：${o.card} ${o.role} 的启动绑定会话 ${o.sessionId}（实际 ${actual.source === "unknown" ? "unknown" : actual.model ?? actual.effort}）`,
    { sessionId: o.sessionId, agent: o.agent, actual }, now);
}

/** 调用点用的那一层：会话已证实（有 session id）才绑；记不上只少一条事实，不改建会话的结论 */
export function bindTierSession(db: Database, task: { project: string; id: string }, agent: string, sessionId: string, role: string): void {
  try { bindLaunchSession(db, { project: task.project, card: task.id, role, agent, sessionId }); } catch (e) {
    console.error(`[task-tier] ${task.id} ${role} 的启动事实没绑上会话：${(e as Error).message}`);
  }
}

export interface LaunchFact {
  plan: LaunchPlan;
  status: "attempted" | "failed" | "bound";
  sessionId: string | null;
  reason: string | null;
  actual: ModelActualRecord;
  createdAt: number;
}

/** 卡上全部启动事实，按尝试先后；读事件本身，不看开关 */
export function taskTierLaunchHistory(db: Database, project: string, card: string): LaunchFact[] {
  const evs = listEvents(db, { project, target: "" }).filter((e: LedgerEvent) => e.kind === "note" && e.data.op === TIER_LAUNCH_OP && e.data.card === card);
  const out: LaunchFact[] = [];
  for (const e of evs) {
    const id = String(e.data.launchId);
    if (e.data.phase === "attempt") out.push({ plan: e.data.plan as LaunchPlan, status: "attempted", sessionId: null, reason: null, actual: UNKNOWN, createdAt: e.ts });
    const f = out.find((x) => x.plan.launchId === id);
    if (!f || f.status !== "attempted") continue;
    if (e.data.phase === "failed") { f.status = "failed"; f.reason = String(e.data.reason ?? ""); }
    if (e.data.phase === "bound") { f.status = "bound"; f.sessionId = String(e.data.sessionId); f.actual = (e.data.actual as ModelActualRecord) ?? UNKNOWN; }
  }
  return out;
}
