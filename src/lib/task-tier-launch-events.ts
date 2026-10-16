/**
 * 类型模型选择的启动事实（TIER3）：每次建会话尝试一行 attempt（角色、类型、家族、轮次、启动标识、建议值、最终参数及来源），
 * 建失败改 failed 并留原因（失败单列，不和成功混），等到 session id 再改 bound 把这次尝试绑到会话上。存在本台账的 task_tier_launches 表
 * （首次写时建；卡的事件流一字不变，旧流程的事件断言不受影响）；同一启动标识只一行，重放不重记。actual 沿用 TIER1b 的 ModelActualRecord：
 * 运行时没证实的一律 unknown，不拿 argv 或默认冒充实际。taskTierLaunchHistory 读表本身，开关后来改 off 也照样读得到（历史保留接口）。
 * tests/task-tier-launch-events.test.ts。
 */
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { getTask, openLedger } from "./ledger-store.js";
import type { ModelActualRecord } from "./lend-wire-types.js";

const UNKNOWN: ModelActualRecord = { model: null, effort: null, source: "unknown" };
const SCHEMA = `CREATE TABLE IF NOT EXISTS task_tier_launches (launchId TEXT PRIMARY KEY NOT NULL, project TEXT NOT NULL, card TEXT NOT NULL,
  role TEXT NOT NULL, plan TEXT NOT NULL, status TEXT NOT NULL, sessionId TEXT, reason TEXT, actual TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`;

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
const hasTable = (db: Database) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_tier_launches'").get();
/** 卡不在本台账（测试替身、远端卡）就不记：启动事实只挂在真有这张卡的台账上 */
const ownCard = (db: Database, plan: Pick<LaunchPlan, "project" | "card">) => getTask(db, plan.card)?.project === plan.project;

export function recordLaunchAttempt(reader: Database, plan: LaunchPlan, now = Date.now()): boolean {
  const db = ledgerWriter(reader);
  if (!ownCard(db, plan)) return false;
  db.run(SCHEMA);
  const r = db.query(`INSERT OR IGNORE INTO task_tier_launches (launchId, project, card, role, plan, status, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, 'attempted', ?, ?)`).run(plan.launchId, plan.project, plan.card, plan.role, JSON.stringify(plan), now, now);
  return r.changes > 0;
}

/** 只改还在 attempted 的那一行：已失败 / 已绑定的不翻案 */
export function recordLaunchFailed(reader: Database, plan: LaunchPlan, reason: string, now = Date.now()): boolean {
  const db = ledgerWriter(reader);
  if (!ownCard(db, plan) || !hasTable(db)) return false;
  return db.query("UPDATE task_tier_launches SET status = 'failed', reason = ?, updatedAt = ? WHERE launchId = ? AND status = 'attempted'")
    .run(reason.slice(0, 400), now, plan.launchId).changes > 0;
}

/**
 * 这张卡这个角色、这个 agent 最近一次还没绑定也没失败的尝试，绑到会话上。actual 不给 = unknown（运行时没证实）。
 * 没有可绑的尝试（开关 off 时建的、或已绑过）返回 false，不补记。
 */
export function bindLaunchSession(reader: Database, o: { project: string; card: string; role: string; agent: string; sessionId: string; actual?: ModelActualRecord },
  now = Date.now()): boolean {
  const db = ledgerWriter(reader);
  if (!hasTable(db)) return false;
  // create 的名字和 registry 里的全名可能差一层 agent- 前缀（manager normalizeName），比较时都去掉
  const bare = (n: string | null) => (n ?? "").replace(/^agent-/, "");
  const open = taskTierLaunchHistory(db, o.project, o.card).findLast((f) => f.plan.role === o.role && bare(f.plan.agent) === bare(o.agent) && f.status === "attempted");
  if (!open) return false;
  return db.query("UPDATE task_tier_launches SET status = 'bound', sessionId = ?, actual = ?, updatedAt = ? WHERE launchId = ? AND status = 'attempted'")
    .run(o.sessionId, JSON.stringify(o.actual ?? UNKNOWN), now, open.plan.launchId).changes > 0;
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

/** 卡上全部启动事实，按尝试先后；读表本身，不看开关 */
export function taskTierLaunchHistory(db: Database, project: string, card: string): LaunchFact[] {
  if (!hasTable(db)) return [];
  const rows = db.query("SELECT * FROM task_tier_launches WHERE project = ? AND card = ? ORDER BY createdAt, rowid").all(project, card) as
    { plan: string; status: LaunchFact["status"]; sessionId: string | null; reason: string | null; actual: string | null; createdAt: number }[];
  return rows.map((r) => ({ plan: JSON.parse(r.plan) as LaunchPlan, status: r.status, sessionId: r.sessionId, reason: r.reason,
    actual: r.actual ? JSON.parse(r.actual) as ModelActualRecord : UNKNOWN, createdAt: r.createdAt }));
}
