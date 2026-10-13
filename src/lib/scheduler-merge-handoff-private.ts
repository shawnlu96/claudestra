/**
 * dispatch-recovery-PRIVLOCK2 · a private-repo card (fileGlobs `repo:<owner>/<name>/…`, PRIVLOCK1) never reaches the merge handoff:
 * the planner hands it to PM with `foreign_repo` first (scheduler-foreign-repo.ts foreignRepoEscalation), and a manual card is no
 * longer stepped. On that very escalation its file locks shrink to the PR's own files, as the handoff does for a public card
 * (scheduler-merge-handoff.ts narrowTarget), so other private cards on the rest of the files are not held for the whole merge.
 * The escalation itself (code, reason, fallback_manual event, PM notice) is untouched: this only adds one ledger record.
 * - entry: escalate whose `code：reason` is exactly foreignRepoReason(cardRepo(task)), stage merge, privateCardRepo set; else nothing;
 * - recovery key `privateMergeNarrow` (off / observe / on, default observe): off reads and writes nothing, observe records
 *   what would happen once per (card, head) through recordObserved, on narrows or records why not once per (card, head);
 * - the PR is read once per (card, head) under one 30 s deadline (clone lookup included, each origin probe started only if it fits; gh at most 15 s of it, the clone's git
 *   steps 15 s together): a step past it is a timeout, and any failure keeps the locks whole and
 *   names the class and exit code only (a private clone's stderr may carry its remote URL), never a local path;
 * - nothing but SchedulerStopped leaves here: a busy ledger or a failed read only means no narrowing.
 * tests/scheduler-merge-handoff-private.test.ts.
 */
import type { Database } from "bun:sqlite";
import { LOCAL_REPO_DIRS, noCloneReason, prCoordinates, privateCardRepo, repoDirFor, type RepoDirIO } from "./card-repo.js";
import { cardFileLocks, withLedgerWriter } from "./ledger-scheduler-lease-sync.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup } from "./ledger-store.js";
import { observeDedupKey, recoveryPolicy, type ObservedAction, type RecoveryPolicyPort } from "./recovery-policy.js";
import { runBounded, type BoundedResult } from "./run-bounded.js";
import { cardRepo, foreignRepoReason } from "./scheduler-foreign-repo.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { narrowPrivateLocks, narrowTarget, observePrivateNarrow, openIntent, privateNarrowKey as narrowKey, type PrFiles } from "./scheduler-merge-handoff.js";
import { ghPrRead, GitStepFailed, handoffFiles } from "./scheduler-merge-handoff-tick.js";
import type { PlannerDecision } from "./scheduler-plan.js";

const KEY = "privateMergeNarrow" as const;
/** PM 审定 10-14: the pass was cut to ~10 s; this read gets 15 s for gh and 15 s for the clone's git, 30 s in all. */
export const PRIVATE_READ_MS = 15_000;
export const PRIVATE_READ_BUDGET_MS = 30_000;
const SPENT: BoundedResult = { code: null, stdout: "", stderr: "", timedOut: true };
/** gitOriginRepo's own spawnSync timeout: a clone probe is started only while this much of the read is left. */
export const ORIGIN_PROBE_MS = 5_000;
const SHA = /^[a-f0-9]{40}$/i;

interface PrivateIo { command: typeof runBounded; repoDirs: RepoDirIO; clock(): number }
const LOCAL_IO: PrivateIo = { command: runBounded, repoDirs: LOCAL_REPO_DIRS, clock: () => Date.now() };
let io = LOCAL_IO;
/** Tests only: fake gh / git, the clone lookup and the clock; null puts the real ones back. */
export function setPrivateNarrowIoForTest(over: Partial<PrivateIo> | null): void { io = over ? { ...LOCAL_IO, ...over } : LOCAL_IO; }

export interface PrivateNarrowCard { db: Database; task: LedgerTask; deps: { now(): number; recoveryPolicy?: RecoveryPolicyPort } }

const observed = (task: LedgerTask, head: string): Pick<ObservedAction, "project" | "mechanism" | "target" | "actionKey"> =>
  ({ project: task.project, mechanism: KEY, target: task.id, actionKey: `h-${head}` });
/**
 * The command with every step cut to what is left of `stepMs` from now and of the read's deadline, whichever ends first; a step
 * started with nothing left is a timeout without running. Each step keeps its own shorter timeout.
 */
function within(deadline: number, stepMs: number): typeof runBounded {
  const until = Math.min(deadline, io.clock() + stepMs);
  return (argv, opts) => {
    const left = until - io.clock();
    return left > 0 ? io.command(argv, { ...opts, timeoutMs: Math.min(opts.timeoutMs, left) }) : Promise.resolve(SPENT);
  };
}
class LookupSpent extends Error {}
/**
 * repoDirFor's search with each origin probe (synchronous, ORIGIN_PROBE_MS at most) started only while a whole probe still fits
 * before the deadline, so the blocking lookup never runs past the read's 30 s; past it the search stops as a timeout.
 */
function cloneWithin(project: string, repo: string, deadline: number): string | null {
  const dirs = io.repoDirs;
  return repoDirFor(project, repo, { ...dirs, origin: (dir) => {
    if (deadline - io.clock() < ORIGIN_PROBE_MS) throw new LookupSpent();
    return dirs.origin(dir);
  } });
}

/** The planner's merge-stage foreign_repo escalation of a private card, word for word; any other escalation is not ours. */
function isPrivateMergeEscalation(task: LedgerTask, plan: PlannerDecision): boolean {
  if (plan.kind !== "escalate" || task.stage !== "merge" || !privateCardRepo(task)) return false;
  const repo = cardRepo(task);
  return !!repo && `${plan.code}：${plan.reason}` === foreignRepoReason(repo);
}

/** The auto tick's one call, right before the escalation; returns nothing and never holds the escalation up. */
export async function narrowPrivateMerge(card: PrivateNarrowCard, plan: PlannerDecision): Promise<void> {
  const { db, task } = card;
  try {
    if (!isPrivateMergeEscalation(task, plan)) return;
    const mode = (card.deps.recoveryPolicy ?? recoveryPolicy)(task.project, KEY).mode;
    if (mode === "off") return;
    const head = task.headSHA ?? "none";
    // settled for this head (PM gave the card back to auto and it came here again): no second read, no second record
    if (getEventByDedup(db, mode === "on" ? narrowKey(task.id, head) : observeDedupKey(observed(task, head)))) return;
    if (openIntent(db, task.id)) return; // as the handoff: an open intent settles on its own, nothing recorded
    const files = await readPrFiles(db, task);
    const now = card.deps.now();
    if (mode === "on") withLedgerWriter(db, (w) => narrowPrivateLocks(w, { now }, { taskId: task.id, head, pr: task.pr, files }));
    else withLedgerWriter(db, (w) => observePrivateNarrow(w, { taskId: task.id, head, pr: task.pr, files }, observed(task, head), now));
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    console.error(`⚠️ [scheduler] ${task.id} 私仓卡合并前没收窄文件锁（照常退回人工）：${(e as Error).message}`);
  }
}

/**
 * The PR's changed paths at the card's head, read as the handoff reads them (ghPrRead + handoffFiles in the private clone), or why
 * not as a class: no clone, origin, gh / git failure or timeout with its exit code, PR state / base / head, a list too long.
 */
async function readPrFiles(db: Database, task: LedgerTask): Promise<PrFiles> {
  const repo = prCoordinates(task.pr)?.repo, head = task.headSHA;
  if (!repo || !task.pr || !head || !SHA.test(head)) return { refused: "卡上没有完整的 PR 链接或 head" };
  // a lock the PR's paths can never match is known before any read
  const locks = narrowTarget(task, cardFileLocks(db, task.id), [], task.pr);
  if ("skipped" in locks) return { refused: locks.skipped };
  const deadline = io.clock() + PRIVATE_READ_BUDGET_MS;
  try {
    const dir = cloneWithin(task.project, repo, deadline);
    if (!dir) return { refused: noCloneReason(repo) };
    const gh = await ghPrRead(task.pr, within(deadline, PRIVATE_READ_MS), PRIVATE_READ_MS);
    if (!gh.ok) return { refused: gh.kind === "timeout" ? "gh pr view 超时" : gh.kind === "malformed" ? "gh pr view 输出不合规" : `gh pr view 失败（exit ${gh.code}）` };
    if (gh.pr.state !== "OPEN") return { refused: `PR 是 ${gh.pr.state}，不是 OPEN` };
    if (gh.pr.base !== "main") return { refused: gh.pr.base === undefined ? "读不到 PR 的 base" : "PR 的 base 不是 main" };
    if (gh.pr.head.toLowerCase() !== head.toLowerCase()) return { refused: `PR head ${gh.pr.head.slice(0, 12)} 不是台账 head ${head.slice(0, 12)}` };
    return await handoffFiles(dir, within(deadline, PRIVATE_READ_MS), PRIVATE_READ_MS)(task.pr, head) ?? { refused: "私仓克隆的 origin 不是 PR 的仓库" };
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    if (e instanceof LookupSpent) return { refused: "查找私仓克隆超时" };
    if (e instanceof GitStepFailed) return { refused: e.code === null ? `git ${e.step} 超时` : `git ${e.step} 失败（exit ${e.code}）` };
    return { refused: "读 PR 改动失败" };
  }
}
