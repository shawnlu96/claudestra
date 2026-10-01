/** Durable scratch cleanup receipts use the existing retirement ledger command; the service's database stays read-only. */
import type { Database } from "bun:sqlite";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getTask } from "./ledger-store.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { RETIRE_STAGES, type SchedulerSession } from "./scheduler-sessions.js";
import { claudeTmpBlocker, claudeTmpSameSlug, removeClaudeTmp, type TmpRemoval } from "./scheduler-retire-tmp.js";
import type { RetireDeps } from "./scheduler-retire.js";
import { worktreeDirs } from "./scheduler-retire-paths.js";

const receiptKey = (intent: string, role: string, effect: string): string => `scheduler:${intent}:${role}:${effect}`;
const brief = (s: string): string => s.replace(/[\s\p{Cc}\p{Cf}]+/gu, " ").slice(0, 240);

/** Slugging is lossy (a.b/a-b, author rv-x/reviewer x): a missing registry entry must not hide another card's directory. */
function otherCard(db: Database, taskId: string, cwd: string, root: string): string | null {
  const rows = db.query("SELECT taskId, role FROM scheduler_sessions WHERE taskId != ? AND transport != 'peer'").all(taskId) as SchedulerSession[];
  for (const r of rows) {
    const other = worktreeDirs(root, r.taskId)[r.role === "author" ? 0 : 1];
    if (other && claudeTmpSameSlug(other, cwd)) return r.taskId;
  }
  return null;
}

async function record(deps: RetireDeps, row: SchedulerSession, intent: SchedulerIntent, effect: "tmp-start" | "tmp", receipt: string): Promise<void> {
  const r = await deps.ledger("ledger", "scheduler-session-retire", row.taskId, "--role", row.role, "--intent", intent.id,
    "--effect", effect, "--receipt", receipt);
  if (r.ok !== true) throw new Error(`临时目录 ${effect} 回执没记上：${String(r.error)}`);
}

/** Once started, a lost result is handed off instead of retrying an unobserved deletion after restart. */
async function cleanup(db: Database, task: LedgerTask, intent: SchedulerIntent, deps: RetireDeps, row: SchedulerSession,
  cwd: string | undefined, removed: readonly string[], inUse: (agent: string) => string | null): Promise<TmpRemoval> {
  if (!cwd || !removed.includes(cwd)) return { ok: false, detail: "worktree 未移除，临时目录保留" };
  const owner = otherCard(db, task.id, cwd, deps.worktreeRoot);
  if (owner) return { ok: false, detail: `临时目录 slug 与 ${owner} 的会话冲突` };
  const agents = await deps.agents(), current = getTask(db, task.id);
  if (!current) return { ok: false, detail: "卡已不存在，临时目录保留" };
  const blocked = claudeTmpBlocker(current.stage, row, cwd, agents), shared = inUse(row.agent);
  if (blocked || shared) return { ok: false, detail: blocked ?? `agent 仍被 ${shared} 使用` };
  if (getEventByDedup(db, receiptKey(intent.id, row.role, "tmp-start"))) return { ok: false, detail: "上轮清理中断，结果待核对，不自动重删" };
  await record(deps, row, intent, "tmp-start", `开始清理本卡 cwd 对应的临时目录：${cwd}`);
  // The ledger child was awaited: refresh the registry after it, then keep the stage check adjacent to the filesystem effect.
  const fresh = await deps.agents();
  const verify = (): void => {
    const now = getTask(db, task.id);
    if (!now || !RETIRE_STAGES.includes(now.stage)) throw new SchedulerStopped("卡阶段已变化，停止临时目录清理");
    if (deps.exists(cwd)) throw new Error("worktree 又出现了，临时目录保留");
    if (inUse(row.agent) || otherCard(db, task.id, cwd, deps.worktreeRoot)) throw new Error("会话归属已变化，临时目录保留");
    const why = claudeTmpBlocker(now.stage, row, cwd, fresh);
    if (why) throw new Error(why);
  };
  return (deps.removeTmp ?? removeClaudeTmp)(cwd, verify);
}

/** Returns only failures for the existing per-tick PM notice. Successes and failures both have per-role events. */
export async function retireClaudeTmp(db: Database, task: LedgerTask, intent: SchedulerIntent, deps: RetireDeps,
  dirs: readonly string[], removed: readonly string[], inUse: (agent: string) => string | null): Promise<string[]> {
  const rows = db.query("SELECT * FROM scheduler_sessions WHERE taskId = ? ORDER BY role").all(task.id) as SchedulerSession[];
  const failures: string[] = [];
  for (const row of rows) {
    if (row.transport === "peer") continue;
    const prior = getEventByDedup(db, receiptKey(intent.id, row.role, "tmp"));
    let result: TmpRemoval;
    if (prior) result = JSON.parse(String(prior.data.receipt)) as TmpRemoval;
    else {
      try { result = await cleanup(db, task, intent, deps, row, dirs[row.role === "author" ? 0 : 1], removed, inUse); }
      catch (e) {
        if (e instanceof SchedulerStopped) throw e;
        result = { ok: false, detail: String((e as Error).message) };
      }
      result.detail = brief(result.detail);
      await record(deps, row, intent, "tmp", JSON.stringify(result));
    }
    if (!result.ok) failures.push(`${row.role} 临时目录未清：${result.detail}`);
  }
  return failures;
}
