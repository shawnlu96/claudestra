/**
 * Who may write a verdict on an auto card, and what it may not do. Only the ledger-bound reviewer session writes it, and
 * only while the registry still runs that session in the bound family, its checkout sits on the reviewed head and an
 * order for that head went to it: a restarted
 * or re-created reviewer replaying the old session id is refused, because the planner trusts the binding. Nobody moves an
 * auto card with `review --to`; PM takes a card back with `workflow-set --mode manual --reason` before writing its own.
 */
import type { Database } from "bun:sqlite";
import { getWorkflow, type AuthorFamily, type SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";
import { readRegistryAgentsSync } from "./registry.js";
import { gitHeadSync } from "./scheduler-review-worktree.js";
import { getSchedulerSession } from "./scheduler-sessions.js";

const TAKE_OVER = "PM 要代记先 workflow-set --mode manual --reason";

export const runtimeFamily = (runtime: string | undefined): AuthorFamily | null =>
  runtime === "codex" ? "codex" : runtime === undefined || runtime === "claude-code" ? "claude" : null;

export function refuseAutoReviewMove(db: Database, task: Pick<LedgerTask, "id">, move: unknown): void {
  if (move && getWorkflow(db, task.id)?.mode === "auto") {
    throw new LedgerError("forbidden", `${task.id} 是自动卡：审查只记结论，不带 --to，阶段由调度器推；要人工推先 workflow-set --mode manual --reason`);
  }
}

interface ReviewCaller {
  actor: string;
  /** The caller's own session from its runtime environment, not from a flag. */
  callerSession?: string;
  registryPath?: string;
  gitHead?(dir: string): string | null;
}

function refusal(db: Database, task: Pick<LedgerTask, "id" | "headSHA">, caller: ReviewCaller,
  claim: { reviewer?: string; session?: string; family?: string; head?: string }): string | null {
  const bound = getSchedulerSession(db, task.id, "reviewer");
  if (!bound || bound.state !== "active") return `${task.id} 是自动卡，还没有台账绑定的审查 session；${TAKE_OVER}`;
  if (caller.actor !== bound.agent) return `${task.id} 是自动卡：结论只由台账绑定的审查员 ${bound.agent} 写（你是 ${caller.actor}）；${TAKE_OVER}`;
  if (claim.reviewer !== bound.agent || claim.session !== bound.sessionId || claim.family !== bound.family) {
    return `--reviewer / --session / --family 要与台账绑定的 ${bound.agent} / ${bound.sessionId} / ${bound.family} 一致`;
  }
  if (caller.callerSession !== bound.sessionId) return `调用方会话（${caller.callerSession ?? "无"}）不是台账绑定的审查 session ${bound.sessionId}`;
  const row = readRegistryAgentsSync(caller.registryPath).find((a) => a.name === bound.agent);
  if (!row || row.sessionId !== bound.sessionId) {
    return `${bound.agent} 在 registry 里的当前 session（${row?.sessionId ?? "无"}）不是台账绑定的 ${bound.sessionId}：审查员换过会话，旧会话的结论不算`;
  }
  if (runtimeFamily(row.runtime) !== bound.family) return `${bound.agent} 现在的 runtime（${row.runtime ?? "claude-code"}）不是绑定的 ${bound.family} 家族`;
  const sent = db.query(`SELECT * FROM scheduler_intents WHERE taskId = ? AND action = 'review' AND status IN ('submitted','done')
    ORDER BY eventSeq DESC LIMIT 1`).get(task.id) as SchedulerIntent | null;
  if (!sent || sent.recipient !== bound.agent || !claim.head || sent.head !== claim.head || task.headSHA !== claim.head) {
    return `没有派给 ${bound.agent} 审 head ${claim.head ?? "（未带 --head）"} 的派审（卡上 head ${task.headSHA ?? "无"}）`;
  }
  const at = row.cwd ? (caller.gitHead ?? gitHeadSync)(row.cwd) : null;
  if (!claim.head || at !== claim.head) return `${bound.agent} 的审查目录 ${row.cwd ?? "（无）"} 停在 ${at ?? "（读不到）"}，不是被审的 head ${claim.head ?? "（未带）"}`;
  return null;
}

/** false = not an auto card (normal PM rules apply); true = the bound reviewer writing its own verdict; throws otherwise. */
export function autoReviewWriter(db: Database, task: Pick<LedgerTask, "id" | "headSHA">, caller: ReviewCaller,
  claim: { reviewer?: string; session?: string; family?: string; head?: string }): boolean {
  if (getWorkflow(db, task.id)?.mode !== "auto") return false;
  const why = refusal(db, task, caller, claim);
  if (why) throw new LedgerError("forbidden", why);
  return true;
}
