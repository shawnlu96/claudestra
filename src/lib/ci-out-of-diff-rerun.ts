/**
 * Out-of-diff rerun (merge-arch-CIRERUN1): a red CI whose failing test files are all outside the PR gets the head's one shared
 * automatic rerun even when no known flaky entry excuses them. It rides CIF8's driver and ledger hooks (ci-known-flaky-rerun.ts),
 * so the claim, its event, the wait, the second-red bounce and restart dedup are CIF1's, and the budget is ciRerunSpent's: a
 * head another mechanism (CIF1 / CIF8 / a train / a person) already re-ran never gets a second one.
 * - Eligibility: the failures come from parseFailedLog, which reads bun test steps only (a red typecheck, guard or build step, or
 *   any line it cannot account for, gives no list); the caller checks every file against the PR files (a list that may be cut
 *   throws); outOfDiffReady re-reads the run: this head's first attempt, ended `failure` (a cancel stays with the cancel path).
 * - Switch `ciOutOfDiffRerun` (new key: on by default). off → ci-known-flaky-rerun.ts runs exactly as before; observe → one
 *   recovery_observe sample, then the usual bounce. Rollback: `ledger scheduler-recovery <project> off --key ciOutOfDiffRerun --reason ...`.
 * tests/ci-out-of-diff-rerun.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { noteDefaultOn } from "./recovery-key-defaults.js";
import { recordObserved, recoveryPolicy, type RecoveryMode } from "./recovery-policy.js";
import type { MergeRun } from "./scheduler-merge.js";

const KEY = "ciOutOfDiffRerun";
/** Event texts stay well under the ledger's 600: the file list is prose, `data.cases` keeps it whole. */
const NAMES_MAX = 300;

let source: ((project: string) => RecoveryMode) | null = null;
/** Tests only: answer the mode without a recovery-policy.json; null restores the file. */
export function setOutOfDiffModeSource(fn: ((project: string) => RecoveryMode) | null): void { source = fn; }
/** Read every time, never throws (recoveryPolicy answers off for a file it cannot read). */
export const outOfDiffMode = (project: string): RecoveryMode => source ? source(project) : recoveryPolicy(project, KEY).mode;

/** The ledger's read: same answer, plus the one recovery_default_on note while the key is on only by its default. */
function ledgerMode(db: Database, project: string, now: number): RecoveryMode {
  if (source) return source(project);
  return noteDefaultOn(db, { project, mechanism: KEY }, recoveryPolicy(project, KEY), now).mode;
}

type RunRead = (repo: string, runId: string) => Promise<{ attempt: number; status: string; conclusion: string; headSha: string }>;

/**
 * Whether the run behind the red is still this head's first attempt and ended in a plain failure. No reader, a read error or
 * any other answer (cancelled, re-run meanwhile, another head) is no: the caller then claims as CIF8 alone would.
 */
export async function outOfDiffReady(runAttempt: RunRead | undefined, red: { repo: string; runId: string }, run: MergeRun,
  prHead: string): Promise<boolean> {
  if (!runAttempt) return false;
  try {
    const r = await runAttempt(red.repo, red.runId);
    return r.attempt === 1 && r.status === "completed" && r.conclusion === "failure" && r.headSha.toLowerCase() === prHead.toLowerCase();
  } catch (e) {
    console.error(`⚠️ [merge] ${run.taskId} 范围外重跑读 run 失败，不按范围外重跑：${(e as Error).message.trim().split("\n")[0]?.slice(0, 300)}`);
    return false;
  }
}

/**
 * Ledger side, inside closeMergeRun's transaction, reached only for a claim the driver marked out-of-diff that no valid known
 * flaky entry took, on a head not re-run yet. on → the text and data CIF1's rerun event is written with; observe → one sample,
 * null; off → null. null leaves the run untouched and the driver bounces as before.
 */
export function outOfDiffClaim(db: Database, ctx: WriteCtx, row: MergeRun, files: string[], claim: { prHead: string; link: string }):
  { text: string; data: Record<string, unknown> } | null {
  const now = ctx.now ?? Date.now();
  const mode = ledgerMode(db, row.project, now);
  if (mode === "off") return null;
  const names = [...files.join("、")].slice(0, NAMES_MAX).join("");
  if (mode === "observe") {
    recordObserved(db, { project: row.project, mechanism: KEY, target: row.taskId, actionKey: `h-${claim.prHead.toLowerCase()}`,
      action: `CI 只红在本卡没碰的测试（${names}），自动重跑一次 ${claim.link}`, data: { intentId: row.intentId, prHead: claim.prHead, run: claim.link, files } }, now);
    return null;
  }
  return { text: `合并队列：CI 只红在本卡没碰的测试（${names}），本 head 自动重跑一次 ${claim.link}`,
    data: { cases: files, outOfDiff: true, reason: "失败的测试文件都不在本 PR 改动里，本 head 还没用过自动重跑" } };
}
