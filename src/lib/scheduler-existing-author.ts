/**
 * An author the owner already created and named on the card is reconciled, not created: when the canonical registry row
 * proves the same task, project, checkout branch, session and runtime family, the ensure binds it without the new-session
 * quota / slot gate and without any create or model call. A proven conflict or an unreadable fact stays unknown for PM;
 * a row that simply lacks the identity fields proves nothing and keeps the full new-session gate.
 */
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { normalizeRegistryAgents, REGISTRY_PATH, type RegistryAgent } from "./registry.js";
import { readJsonStateSync } from "./state-file.js";
import { runtimeFamily } from "./scheduler-auto-review.js";
import type { Git } from "./scheduler-review-worktree.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";

export type ExistingAuthor = { kind: "verified" } | { kind: "conflict"; reason: string } | { kind: "unproven" };

const taskOf = (label: string): string => label.trim().split(/\s+/)[0] ?? "";

export async function existingAuthorIdentity(task: Pick<LedgerTask, "id" | "project" | "branch" | "agent">, row: RegistryAgent,
  family: AuthorFamily, git: Git): Promise<ExistingAuthor> {
  const name = row.name;
  if (task.agent !== name) return { kind: "conflict", reason: `registry 行 ${name} 不是卡上执行者 ${task.agent ?? "（无）"}` };
  if (runtimeFamily(row.runtime) !== family) return { kind: "conflict", reason: `${name} 的 runtime（${row.runtime ?? "claude-code"}）不是要求的 ${family} 家族` };
  if (row.projectId !== undefined && row.projectId !== task.project) return { kind: "conflict", reason: `${name} 属于项目 ${row.projectId}，不是 ${task.project}` };
  if (row.task !== undefined && taskOf(row.task).toLowerCase() !== task.id.toLowerCase()) {
    return { kind: "conflict", reason: `${name} 在 registry 登记的任务是「${row.task}」，不是 ${task.id}` };
  }
  if (row.projectId === undefined || row.task === undefined || !row.cwd || !row.sessionId || !task.branch
    || (row.status !== undefined && row.status !== "active")) return { kind: "unproven" };
  let head: { code: number; out: string };
  try { head = await git(["-C", row.cwd, "rev-parse", "--abbrev-ref", "HEAD"]); }
  catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    return { kind: "conflict", reason: `读不出 ${name} 工作目录的分支：${(e as Error).message}` };
  }
  if (head.code !== 0) return { kind: "conflict", reason: `读不出 ${name} 工作目录 ${row.cwd} 的分支：${head.out}`.slice(0, 400) };
  if (head.out !== task.branch) return { kind: "conflict", reason: `${name} 工作目录在分支 ${head.out}，不是本卡 ${task.branch}` };
  return { kind: "verified" };
}

/** Cached registry rows are useful to UI readers but cannot authorize session reconciliation. */
export function freshExistingAuthor(agent: string, registryPath = REGISTRY_PATH): { row?: RegistryAgent; unreadable?: string } {
  const read = readJsonStateSync(registryPath);
  if (read.status !== "ok") return { unreadable: `registry ${read.status === "missing" ? "缺失" : read.error}` };
  return { row: normalizeRegistryAgents(read.data).find((row) => row.name === agent) };
}
