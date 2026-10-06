/**
 * A retired agent's own checkout (LIFE3, from agent-lifecycle-run.ts): only a linked, unlocked worktree directly under the root that no
 * current agent works in and the ledger does not hold (agent-lifecycle-cleanup-hold.ts). Tracked change: kept as is, the reason names
 * files and kinds. Untracked / ignored only: archived and verified, then holders, ledger and survey re-read; only when nothing changed
 * are the archived untracked files unlinked and `git worktree remove` (no --force) run. Any read failure keeps it and returns why.
 */
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { archiveSurvey } from "./agent-lifecycle-cleanup-archive.js";
import { readWriteHold } from "./agent-lifecycle-cleanup-hold.js";
import { ownedPath, surveyCheckout, type Survey } from "./agent-lifecycle-cleanup-scan.js";
import { ARCHIVE_ROOT } from "./paths.js";
import { type LiveAgent, stopped, within } from "./scheduler-retire.js";
import type { Git } from "./scheduler-review-worktree.js";

export { dueRetries, gatedCollect } from "./agent-lifecycle-cleanup-gate.js";

/** Test seams for where archives, the retry state and the ledger live (production: the state dir). */
export interface CleanupOpts { cleanupArchiveRoot?: string; cleanupStatePath?: string; cleanupLedgerPath?: string }
export interface WorktreeCleanupDeps extends CleanupOpts { git: Git; worktreeRoot: string; now(): number }
/** The plan's action: who owned it (agent + session, a retry's createdAt), which card, which rule. */
export interface CheckoutOwner { agent: string; sessionId?: string; regAt?: number; taskId?: string | null; rule?: string }

const holderOf = (agents: readonly LiveAgent[], dir: string, real: string): LiveAgent | undefined =>
  agents.find((a) => !stopped(a) && a.cwd && (within(a.cwd, dir) || within(a.cwd, real)));

/** The PM-facing list of what blocks an automatic cleanup: real names, grouped by kind. */
function trackedSummary(s: Pick<Survey, "tracked">): string {
  const kinds = new Map<string, string[]>();
  for (const t of s.tracked) kinds.set(t.kind, [...(kinds.get(t.kind) ?? []), t.path]);
  const label: Record<string, string> = { conflict: "冲突", staged: "已暂存", modified: "已修改", "staged+modified": "暂存后又改" };
  return [...kinds].map(([k, ps]) => `${label[k] ?? k} ${ps.length}：${ps.slice(0, 8).join(", ")}${ps.length > 8 ? " …" : ""}`).join("；");
}

const sameSurvey = (a: Survey, b: Survey): boolean => a.id === b.id && !b.tracked.length;

/**
 * Cleans the checkout or says why not (null = gone, nothing of value lost). `agents` are the holders read for this pass (self
 * excluded by the caller); `reread` reads them again right before anything is moved. Steps for the ledger event go to `steps`.
 */
export async function retireWorktree(deps: WorktreeCleanupDeps, dir: string, owner: CheckoutOwner, agents: readonly LiveAgent[],
  reread: () => Promise<LiveAgent[]>, steps: string[]): Promise<string | null> {
  const where = await ownedPath(deps.worktreeRoot, dir);
  if (!where) return null;
  if ("why" in where) return where.why;
  const { real } = where;
  const held = holderOf(agents, dir, real);
  if (held) return `${held.name} 还在这里工作（agent 没停）`;
  const hold = readWriteHold(deps.cleanupLedgerPath, owner);
  if (hold) return hold;
  const s = await surveyCheckout(deps.git, real);
  if (typeof s === "string") return s;
  if (s.tracked.length) return `有已跟踪改动，原样保留交 PM（不搬未跟踪文件）：${trackedSummary(s)}`;
  let archived: string | null = null;
  if (s.entries.length || s.excluded.length) {
    const r = await archiveSurvey(deps.cleanupArchiveRoot ?? ARCHIVE_ROOT, { agent: owner.agent, sessionId: owner.sessionId ?? null,
      regAt: owner.regAt ?? null, checkout: dir }, s, deps.now());
    if ("why" in r) return r.why;
    archived = r.dir;
  }
  // re-read everything the decision rests on: a holder that appeared, a file written since the survey → nothing is moved
  const again = holderOf(await reread(), dir, real);
  if (again) return `${again.name} 刚进了这个目录，没动${archived ? `（归档已在 ${archived}）` : ""}`;
  const held2 = readWriteHold(deps.cleanupLedgerPath, owner);
  if (held2) return `${held2}${archived ? `（归档已在 ${archived}）` : ""}`;
  const s2 = await surveyCheckout(deps.git, real);
  if (typeof s2 === "string" || !sameSurvey(s, s2)) {
    const what = typeof s2 === "string" ? s2 : s2.tracked.length ? trackedSummary(s2) : "未跟踪文件有变";
    return `复核时内容变了，这轮不动${archived ? `（这一版归档在 ${archived}）` : ""}：${what}`;
  }
  const moved = s.entries.filter((e) => !e.ignored && e.type !== "dir");
  for (const e of moved) {
    const err = await unlink(join(real, e.path)).then(() => null, (x: Error) => x.message);
    if (err) return `归档后移走 ${e.path} 失败，其余保留（归档在 ${archived}）：${err}`;
  }
  const skipped = s.excluded.length ? `；可再生目录不归档（清单里列名）：${s.excluded.join(", ")}` : "";
  if (archived) steps.push(`未跟踪资料 ${s.entries.length} 项已归档并核对 → ${archived}${skipped}`);
  const rm = await deps.git(["-C", real, "worktree", "remove", real]);
  return rm.code === 0 ? null : `git worktree remove 失败${archived ? `（未跟踪资料已归档在 ${archived}）` : ""}：${rm.out}`;
}
