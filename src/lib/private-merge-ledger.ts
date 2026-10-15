/**
 * merge-arch-MERGEAUTO1 · the private merge's ledger reads and its two writes (bounce names, file locks):
 * - serial: one private repository merges one card at a time, judged on the ledger's open merge runs (scheduler_merges), so a
 *   restart loses nothing: a run already `merging` goes first, else the oldest run (createdAt, then intent id); the rest wait;
 * - bounce names: a private repository's red required checks carry their own names (not the project's), so just before the bounce
 *   the run's fixed check list is set to the private repository's verified ones (privateBounceChecks), the ledger's bounce gate
 *   (scheduler-merge-conflict.ts closeMergeRun) then takes them unchanged; the bounce ends the run, a refused bounce puts the list back;
 * - narrowing (privateMergeNarrow, kept): the private card no longer goes to PM under on, so this path narrows its file locks once
 *   per (card, head) with the existing narrowTarget / replaceCardFileLocks under the same dedup key the PM branch uses
 *   (scheduler-merge-handoff.ts privateNarrowKey); observe records what it would do, off does nothing. Best effort: a failure
 *   keeps the locks whole and names the class and exit code only, never a path or stderr.
 * tests/private-merge*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { prCoordinates } from "./card-repo.js";
import { mustTask } from "./ledger-checks.js";
import { cardFileLocks, replaceCardFileLocks } from "./ledger-scheduler-lease-sync.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { observeDedupKey, recordObserved } from "./recovery-policy.js";
import type { runBounded } from "./run-bounded.js";
import { parseRequiredChecks } from "./scheduler-config.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { narrowTarget, privateNarrowKey, type PrFiles } from "./scheduler-merge-handoff.js";
import { GitStepFailed, handoffFiles } from "./scheduler-merge-handoff-tick.js";
import type { MergeRun } from "./scheduler-merge.js";
import { privateMergeMode, privateMergePorts } from "./private-merge-gate.js";

const OPEN_PHASES = ["ready", "updating", "await_ci", "merging"];

/** The open merge run of `repo` that goes first (null = none open); the caller waits unless it is its own. */
export function privateMergeTurn(db: Database, repo: string): Pick<MergeRun, "intentId" | "taskId" | "phase"> | null {
  const rows = db.query(`SELECT intentId, taskId, prRef, phase, createdAt FROM scheduler_merges
    WHERE phase IN (${OPEN_PHASES.map(() => "?").join(",")}) ORDER BY createdAt, intentId`).all(...OPEN_PHASES) as
    (Pick<MergeRun, "intentId" | "taskId" | "prRef" | "phase" | "createdAt">)[];
  const mine = rows.filter((r) => prCoordinates(r.prRef)?.repo.toLowerCase() === repo);
  return mine.find((r) => r.phase === "merging") ?? mine[0] ?? null;
}

const BOUNCE_PHASES = ["ready", "updating", "await_ci"];

/**
 * Rechecked inside each write's own immediate transaction, before anything is written: the scheduler's lease (`assertActive`),
 * privateRepoMerge still on, and the card still at this merge (stage merge, head = the reviewed head, same PR). False = write nothing.
 */
function stillOurs(db: Database, at: { project: string; taskId: string; head: string; pr: string }, assertActive: () => void): boolean {
  assertActive();
  if (privateMergeMode(at.project) !== "on") return false;
  const task = mustTask(db, at.taskId);
  return task.stage === "merge" && task.headSHA === at.head && task.pr === at.pr;
}

/**
 * Just before a red-CI bounce, the run's check list becomes the names this pass read from GitHub for the reviewed head (`names`,
 * the ledger's 1–20 name rule), so the bounce can name them for the fix; only while the run has not sent a merge and is at the rev
 * the driver holds, and only after stillOurs. The bounce then ends the run: no merge is ever judged on this list, and the card's own
 * merge requirements are not touched. Returns the undo (puts the old list back if the run is still that open run), or null when the
 * names, the run or the card do not fit: the caller then goes to PM.
 */
export function privateBounceChecks(db: Database, run: MergeRun, names: readonly string[],
  at: { head: string; assertActive: () => void }): (() => void) | null {
  const checks = parseRequiredChecks([...names]);
  if (!checks) return null;
  const list = checks.join(","), marks = BOUNCE_PHASES.map(() => "?").join(",");
  const update = (to: string, from: string) => db.query(`UPDATE scheduler_merges SET requiredChecks=?
    WHERE intentId=? AND rev=? AND requiredChecks=? AND phase IN (${marks})`).run(to, run.intentId, run.rev, from, ...BOUNCE_PHASES).changes;
  const ours = { project: run.project, taskId: run.taskId, head: at.head, pr: run.prRef };
  if (list !== run.requiredChecks && tx(db, () => stillOurs(db, ours, at.assertActive) ? update(list, run.requiredChecks) : 0) !== 1) return null;
  return () => { if (list !== run.requiredChecks) tx(db, () => update(run.requiredChecks, list)); };
}

const NARROW_KEY = "privateMergeNarrow" as const;
const NARROW_OP = "merge_private_narrow"; // scheduler-merge-handoff.ts's own op: the PM branch reads the same record
const NARROW_MS = 15_000;

async function prFiles(dir: string, pr: string, head: string, command: typeof runBounded): Promise<PrFiles> {
  try {
    return await handoffFiles(dir, command, NARROW_MS)(pr, head) ?? { refused: "私仓检出的 origin 不是 PR 的仓库" };
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    if (e instanceof GitStepFailed) return { refused: e.code === null ? `git ${e.step} 超时` : `git ${e.step} 失败（exit ${e.code}）` };
    return { refused: "读 PR 改动失败" };
  }
}

/** on: the card's locks down to PR ∩ fileGlobs, or one record of why not, once per (card, head), while its merge intent is open. */
function narrowLocks(db: Database, input: { taskId: string; head: string; pr: string; files: PrFiles }, now: number,
  assertActive: () => void): void {
  tx(db, () => {
    const task = mustTask(db, input.taskId), key = privateNarrowKey(task.id, input.head);
    if (!stillOurs(db, { project: task.project, ...input }, assertActive) || getEventByDedup(db, key)) return;
    const held = cardFileLocks(db, task.id);
    const target = "refused" in input.files ? { skipped: input.files.refused } : narrowTarget(task, held, input.files, input.pr);
    const repo = prCoordinates(input.pr)?.repo.toLowerCase() ?? null;
    const write = (text: string, data: Record<string, unknown>) => insertEvent(db, { actor: "scheduler", now, dedupKey: key },
      { project: task.project, target: task.id, kind: "scheduler", text, data: { op: NARROW_OP, head: input.head, repo, ...data } }, true);
    if ("skipped" in target) { write(`私仓合并前文件锁不收窄：${target.skipped}`, { skipped: target.skipped }); return; }
    replaceCardFileLocks(db, task, held, target.to, now);
    write(`私仓合并前文件锁收窄到 PR 实际改动：${target.from.length} → ${target.to.length} 把`, { from: target.from, to: target.to, files: target.paths });
  });
}

/** Once per (card, head) under privateMergeNarrow's mode; never throws but SchedulerStopped. */
export async function narrowPrivateOnce(db: Database, task: LedgerTask, dir: string, assertActive: () => void): Promise<void> {
  const head = task.headSHA, pr = task.pr;
  if (!head || !pr) return;
  try {
    const { policy, command, now } = privateMergePorts();
    const mode = policy(task.project, NARROW_KEY).mode;
    if (mode === "off") return;
    const note = { project: task.project, mechanism: NARROW_KEY, target: task.id, actionKey: `h-${head}` };
    if (getEventByDedup(db, mode === "on" ? privateNarrowKey(task.id, head) : observeDedupKey(note))) return;
    assertActive();
    const files = await prFiles(dir, pr, head, command);
    assertActive();
    if (mode === "on") return narrowLocks(db, { taskId: task.id, head, pr, files }, now(), assertActive);
    const target = "refused" in files ? { skipped: files.refused } : narrowTarget(task, cardFileLocks(db, task.id), files, pr);
    recordObserved(db, { ...note, action: "skipped" in target ? `不收窄：${target.skipped}` : `收窄 ${target.from.length} → ${target.to.length} 把`,
      data: "skipped" in target ? { head, skipped: target.skipped } : { head, from: target.from, to: target.to } }, now());
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    console.error(`⚠️ [private-merge] ${task.id} 私仓合并前没收窄文件锁（合并照常）：${(e as Error).message}`);
  }
}
