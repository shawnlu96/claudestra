/**
 * A retired agent's own checkout, end to end (LIFE3; called from agent-lifecycle-run.ts in place of a bare removeCleanWorktree):
 *   1. it is a real directory directly under the worktree root (no symlink, no outside path), a linked, unlocked worktree whose
 *      admin dir is the repo's, and no current agent (any name or session not stopped for good) works in it;
 *   2. tracked change (modified / staged / conflict), a submodule, hidden index flags or a HEAD on no branch: kept as it is, the
 *      reason names the files and kinds (agent-lifecycle-cleanup-gate.ts makes it one PM notice per state);
 *   3. only untracked / ignored files: all archived and verified (agent-lifecycle-cleanup-archive.ts), then holders and the whole
 *      survey are read again, and only when nothing changed are the archived untracked files unlinked (their verified copies are
 *      the move) and `git worktree remove` runs, without --force; git deletes the ignored ones it would delete anyway.
 * Any read failing (registry, tmux, git, the disk) keeps the checkout and returns why: a reason is never read as "done".
 */
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { archiveSurvey } from "./agent-lifecycle-cleanup-archive.js";
import { ownedPath, surveyCheckout, type Survey } from "./agent-lifecycle-cleanup-scan.js";
import { ARCHIVE_ROOT } from "./paths.js";
import { type LiveAgent, stopped, within } from "./scheduler-retire.js";
import type { Git } from "./scheduler-review-worktree.js";

export { dueRetries, gatedCollect } from "./agent-lifecycle-cleanup-gate.js";

/** Test seams for where archives and the retry state live (production: the state dir). */
export interface CleanupOpts { cleanupArchiveRoot?: string; cleanupStatePath?: string }
export interface WorktreeCleanupDeps extends CleanupOpts { git: Git; worktreeRoot: string; now(): number }
export interface CheckoutOwner { agent: string; sessionId?: string; regAt?: number }

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
  const s = await surveyCheckout(deps.git, real);
  if (typeof s === "string") return s;
  if (s.tracked.length) return `有已跟踪改动，原样保留交 PM（不搬未跟踪文件）：${trackedSummary(s)}`;
  let archived: string | null = null;
  if (s.entries.length) {
    const r = await archiveSurvey(deps.cleanupArchiveRoot ?? ARCHIVE_ROOT, { agent: owner.agent, sessionId: owner.sessionId ?? null,
      regAt: owner.regAt ?? null, checkout: dir }, s, deps.now());
    if ("why" in r) return r.why;
    archived = r.dir;
  }
  // re-read everything the decision rests on: a holder that appeared, a file written since the survey → nothing is moved
  const again = holderOf(await reread(), dir, real);
  if (again) return `${again.name} 刚进了这个目录，没动${archived ? `（归档已在 ${archived}）` : ""}`;
  const s2 = await surveyCheckout(deps.git, real);
  if (typeof s2 === "string" || !sameSurvey(s, s2)) {
    return `复核时内容变了，这轮不动${archived ? `（这一版归档在 ${archived}）` : ""}：${typeof s2 === "string" ? s2 : s2.tracked.length ? trackedSummary(s2) : "未跟踪文件有变"}`;
  }
  const moved = s.entries.filter((e) => !e.ignored && e.type !== "dir");
  for (const e of moved) {
    const err = await unlink(join(real, e.path)).then(() => null, (x: Error) => x.message);
    if (err) return `归档后移走 ${e.path} 失败，其余保留（归档在 ${archived}）：${err}`;
  }
  if (archived) steps.push(`未跟踪资料 ${s.entries.length} 项已归档并核对 → ${archived}${s.excluded.length ? `；可再生目录不归档：${s.excluded.join(", ")}` : ""}`);
  const rm = await deps.git(["-C", real, "worktree", "remove", real]);
  return rm.code === 0 ? null : `git worktree remove 失败${archived ? `（未跟踪资料已归档在 ${archived}）` : ""}：${rm.out}`;
}
