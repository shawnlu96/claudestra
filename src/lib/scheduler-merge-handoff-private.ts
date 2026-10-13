/**
 * dispatch-recovery-PRIVLOCK2 · a private-repo card (fileGlobs `repo:<owner>/<name>/…`, PRIVLOCK1) never reaches the merge handoff:
 * the planner hands it to PM with `foreign_repo` first (scheduler-foreign-repo.ts foreignRepoEscalation), and a manual card is no
 * longer stepped. On that very escalation its file locks shrink to the PR's own files, as the handoff does for a public card
 * (scheduler-merge-handoff.ts narrowTarget), so other private cards on the rest of the files are not held for the whole merge.
 * The escalation itself (code, reason, fallback_manual event, PM notice) is untouched: this only adds one ledger record.
 * - entry: escalate whose `code：reason` is exactly foreignRepoReason(cardRepo(task)), stage merge, privateCardRepo set; else nothing;
 * - recovery key `privateMergeNarrow` (off / observe / on, default observe): off reads and writes nothing, observe records
 *   what would happen once per (card, head) through recordObserved, on narrows or records why not once per (card, head);
 * - the PR is read once per (card, head), within a 30 s budget (gh 15 s, git 15 s per step): any failure keeps the locks whole and
 *   names the class and exit code only (a private clone's stderr may carry its remote URL), never a local path;
 * - nothing but SchedulerStopped leaves here: a busy ledger or a failed read only means no narrowing.
 * tests/scheduler-merge-handoff-private.test.ts.
 */
import type { Database } from "bun:sqlite";
import { noCloneReason, prCoordinates, privateCardRepo, repoDirFor } from "./card-repo.js";
import { mustTask } from "./ledger-checks.js";
import { cardFileLocks, replaceCardFileLocks, withLedgerWriter } from "./ledger-scheduler-lease-sync.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { observeDedupKey, recordObserved, recoveryPolicy, type ObservedAction, type RecoveryPolicyPort } from "./recovery-policy.js";
import { runBounded } from "./run-bounded.js";
import { cardRepo, foreignRepoReason } from "./scheduler-foreign-repo.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { narrowedText, narrowTarget, type NarrowResult } from "./scheduler-merge-handoff.js";
import { ghPrRead, GitStepFailed, handoffFiles } from "./scheduler-merge-handoff-tick.js";
import type { PlannerDecision } from "./scheduler-plan.js";

const OP = "merge_private_narrow";
const KEY = "privateMergeNarrow" as const;
/** PM 审定 10-14: the pass was cut to ~10 s; this read gets 15 s for gh and 15 s for the clone's fetch. */
export const PRIVATE_READ_MS = 15_000;
const SHA = /^[a-f0-9]{40}$/i;
const NO_HEAD = "none";

interface PrivateIo { command: typeof runBounded; repoDir(project: string, repo: string): string | null }
const LOCAL_IO: PrivateIo = { command: runBounded, repoDir: (project, repo) => repoDirFor(project, repo) };
let io = LOCAL_IO;
/** Tests only: fake gh / git and the clone lookup; null puts the real ones back. */
export function setPrivateNarrowIoForTest(over: Partial<PrivateIo> | null): void { io = over ? { ...LOCAL_IO, ...over } : LOCAL_IO; }

export interface PrivateNarrowCard { db: Database; task: LedgerTask; deps: { now(): number; recoveryPolicy?: RecoveryPolicyPort } }
type PrFiles = readonly string[] | { refused: string };

const narrowKey = (taskId: string, head: string): string => `scheduler:${OP}:${taskId}:${head}`;
const observed = (task: LedgerTask, head: string): Pick<ObservedAction, "project" | "mechanism" | "target" | "actionKey"> =>
  ({ project: task.project, mechanism: KEY, target: task.id, actionKey: `h-${head}` });
const openIntent = (db: Database, taskId: string): boolean =>
  !!db.query("SELECT 1 FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown') LIMIT 1").get(taskId);

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
    const head = task.headSHA ?? NO_HEAD;
    // settled for this head (PM gave the card back to auto and it came here again): no second read, no second record
    if (getEventByDedup(db, mode === "on" ? narrowKey(task.id, head) : observeDedupKey(observed(task, head)))) return;
    if (openIntent(db, task.id)) return; // as the handoff: an open intent settles on its own, nothing recorded
    const files = await readPrFiles(db, task);
    const now = card.deps.now();
    if (mode === "on") withLedgerWriter(db, (w) => narrowPrivateLocks(w, { now }, { taskId: task.id, head, pr: task.pr, files }));
    else withLedgerWriter(db, (w) => observeNarrow(w, task, head, files, now));
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
  const dir = io.repoDir(task.project, repo);
  if (!dir) return { refused: noCloneReason(repo) };
  try {
    const gh = await ghPrRead(task.pr, io.command, PRIVATE_READ_MS);
    if (!gh.ok) return { refused: gh.kind === "timeout" ? "gh pr view 超时" : gh.kind === "malformed" ? "gh pr view 输出不合规" : `gh pr view 失败（exit ${gh.code}）` };
    if (gh.pr.state !== "OPEN") return { refused: `PR 是 ${gh.pr.state}，不是 OPEN` };
    if (gh.pr.base !== "main") return { refused: gh.pr.base === undefined ? "读不到 PR 的 base" : "PR 的 base 不是 main" };
    if (gh.pr.head.toLowerCase() !== head.toLowerCase()) return { refused: `PR head ${gh.pr.head.slice(0, 12)} 不是台账 head ${head.slice(0, 12)}` };
    return await handoffFiles(dir, io.command, PRIVATE_READ_MS)(task.pr, head) ?? { refused: "私仓克隆的 origin 不是 PR 的仓库" };
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    if (e instanceof GitStepFailed) return { refused: e.code === null ? `git ${e.step} 超时` : `git ${e.step} 失败（exit ${e.code}）` };
    return { refused: "读 PR 改动失败" };
  }
}

/**
 * on: the card's locks down to PR ∩ fileGlobs (narrowTarget), or one record of why not, once per (card, head). Rechecked in the
 * writer's transaction: a card that left this merge or this head, or got an open intent, is left alone and nothing is recorded.
 */
export function narrowPrivateLocks(db: Database, ctx: { now: number },
  input: { taskId: string; head: string; pr: string | null; files: PrFiles }): NarrowResult {
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    if (task.stage !== "merge" || (task.headSHA ?? NO_HEAD) !== input.head || task.pr !== input.pr) {
      return { narrowed: false, reason: "卡已不在这次 merge 上（阶段、head 或 PR 已变）" };
    }
    const key = narrowKey(task.id, input.head), repo = prCoordinates(task.pr)?.repo.toLowerCase() ?? null;
    const prev = getEventByDedup(db, key);
    if (prev) {
      return prev.data.skipped ? { narrowed: false, reason: String(prev.data.skipped) }
        : { narrowed: true, from: prev.data.from as string[], to: prev.data.to as string[], duplicate: true };
    }
    if (openIntent(db, task.id)) return { narrowed: false, reason: "卡还有未结调度意图" };
    const write = (text: string, data: Record<string, unknown>) => insertEvent(db, { actor: "scheduler", now: ctx.now, dedupKey: key },
      { project: task.project, target: task.id, kind: "scheduler", text, data: { op: OP, head: input.head, repo, ...data } }, true);
    const held = cardFileLocks(db, task.id);
    const target = "refused" in input.files ? { skipped: input.files.refused } : narrowTarget(task, held, input.files, task.pr ?? "");
    if ("skipped" in target) {
      write(`交接后文件锁不收窄：${target.skipped}`, { skipped: target.skipped });
      return { narrowed: false, reason: target.skipped };
    }
    replaceCardFileLocks(db, task, held, target.to, ctx.now);
    write(narrowedText(target.from, target.to), { from: target.from, to: target.to, files: target.paths });
    return { narrowed: true, from: target.from, to: target.to, duplicate: false };
  });
}

/** observe: what on would do, one recovery note per (card, head); the locks stay as they are. */
function observeNarrow(db: Database, task: LedgerTask, head: string, files: PrFiles, now: number): void {
  const target = "refused" in files ? { skipped: files.refused } : narrowTarget(task, cardFileLocks(db, task.id), files, task.pr ?? "");
  const action = "skipped" in target ? `不收窄：${target.skipped}` : `收窄 ${target.from.length} → ${target.to.length} 把`;
  const data = "skipped" in target ? { head, skipped: target.skipped } : { head, from: target.from, to: target.to, repo: target.repo };
  recordObserved(db, { ...observed(task, head), action, data }, now);
}
