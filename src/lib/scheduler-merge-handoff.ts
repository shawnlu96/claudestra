/**
 * Merge handoff (MHO1, docs/architecture/merge-handoff.md): in a project whose scheduler.json says `mergeHandoff`, the
 * repository owner merges. An auto card in `merge` is handed over with this machine's review evidence instead of entering the
 * merge queue, and moves to live only once GitHub shows its PR merged at the handed-over head, or at one reached from it only by
 * merging main in (each hop a carry record). Nothing here talks to GitHub: the auto tick reads the PR
 * (scheduler-merge-handoff-tick.ts) and these writes recheck the ledger in their own transaction.
 */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getWorkflow, resourceKey, type AuthorFamily, type TaskWorkflow, type WorkflowTemplate } from "./ledger-scheduler.js";
import { canTransition, nextTaskState, type LedgerEvent, type LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getMeta, LedgerError, listEvents } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { releaseFinishedCardLeases } from "./ledger-scheduler-lease.js";
import { cardFileLocks, coveredBy, replaceCardFileLocks, type FileLock } from "./ledger-scheduler-lease-sync.js";
import { prCoordinates } from "./card-repo.js";
import { recordObserved, type ObservedAction } from "./recovery-policy.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { mergeReviewProof } from "./scheduler-merge.js";
import { uiMergeRefusal } from "./scheduler-ui-merge-refusal.js";

/**
 * What goes with the PR (field list and meaning in the doc). Grouped by kind of proof so a later one (CI, owner acceptance,
 * a peer's countersignature) is a new key next to `review`; a changed meaning bumps `v` instead of reusing a name.
 */
interface HandoffEvidence {
  v: 1;
  pr: string;
  /** Pinned head: at handoff the PR head, the card's head and the reviewed head are this one commit. */
  head: string;
  specRev: number;
  template: WorkflowTemplate;
  /** Family that wrote the head (a peer's delivery counts as its own family). */
  authorFamily: AuthorFamily;
  review: { round: number; verdict: "pass" | "changes"; reviewerFamily: AuthorFamily; reportPath: string; p2: number; reviewSeq: number };
}

const SHA = /^[a-f0-9]{40}$/i;
const CARRY_OP = "merge_handoff_carry";
/** How a carry was proved (scheduler-main-merge-carry.ts): the new tree is git's clean merge, or the net diff is byte-identical. */
const CARRY_BASIS = ["auto-merge", "net-diff"] as const;
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/;

/** The card's latest entry into `merge`: a handoff belongs to one stay there, a card that comes back hands over again. */
const mergeEntry = (events: readonly LedgerEvent[]): number => events.findLast((e) => e.kind === "stage" && e.data.to === "merge")?.seq ?? 0;

/** This stay's handoff and the PR head it follows now: the handed head, moved on by each carry recorded after it. */
export interface HandoffFollow { event: LedgerEvent; evidence: HandoffEvidence; head: string; carrySeq: number | null }
export function handoffOf(db: Database, task: LedgerTask): HandoffFollow | null {
  const events = listEvents(db, { project: task.project, target: task.id });
  const since = mergeEntry(events);
  const event = events.findLast((e) => e.seq > since && e.kind === "scheduler" && e.data.op === "merge_handoff");
  if (!event) return null;
  const evidence = event.data.evidence as HandoffEvidence;
  let head = evidence.head, carrySeq: number | null = null;
  // only the scheduler's own carries, each starting where the last ended (recordHandoffCarry checks it in its transaction)
  for (const e of events) {
    if (e.seq <= event.seq || e.kind !== "scheduler" || e.actor !== "scheduler" || e.data.op !== CARRY_OP || e.data.handoffSeq !== event.seq) continue;
    if (e.data.from === head && typeof e.data.to === "string" && SHA.test(e.data.to)) [head, carrySeq] = [e.data.to, e.seq];
  }
  return { event, evidence, head, carrySeq };
}

/** Scheduler only, auto card in `merge` on this spec, at exactly this full head and PR. */
export function handoffCard(db: Database, ctx: WriteCtx, input: { taskId: string; head: string; pr: string }): { task: LedgerTask; workflow: TaskWorkflow } {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "合并交接只由调度服务记");
  const task = mustTask(db, input.taskId), workflow = getWorkflow(db, task.id);
  if (task.stage !== "merge" || workflow?.mode !== "auto" || workflow.specRev !== task.specRev) {
    throw new LedgerError("conflict", "任务不在自动流程的 merge 阶段，或规格版本已变");
  }
  if (!SHA.test(input.head) || task.headSHA !== input.head) throw new LedgerError("conflict", "交接的 head 不是任务当前的完整 head");
  if (!PR_URL.test(input.pr) || task.pr !== input.pr) throw new LedgerError("conflict", "交接的 PR 不是任务上的完整 GitHub PR URL");
  return { task, workflow };
}

/** Write the handoff record once per stay in `merge` and head; a replay returns the first record. */
export function recordMergeHandoff(db: Database, ctx: WriteCtx, input: { taskId: string; head: string; pr: string }): { event: LedgerEvent; duplicate: boolean } {
  return tx(db, () => {
    const { task, workflow } = handoffCard(db, ctx, input);
    const events = listEvents(db, { project: task.project, target: task.id });
    const key = `scheduler:merge_handoff:${task.id}:s${mergeEntry(events)}:${input.head}`;
    const prev = getEventByDedup(db, key);
    if (prev) return { event: prev, duplicate: true };
    if (getMeta(db, task.project).queueFrozen.frozen) throw new LedgerError("conflict", "项目合并队列已冻结");
    const now = ctx.now ?? Date.now();
    const ui = workflow.template === "ui" ? uiMergeRefusal(db, task, now) : null;
    if (ui) throw new LedgerError("conflict", ui);
    const review = mergeReviewProof(db, task, workflow);
    if (review.head !== input.head) throw new LedgerError("conflict", "审查结论不是这个 head 的");
    const evidence: HandoffEvidence = { v: 1, pr: input.pr, head: input.head, specRev: task.specRev, template: workflow.template,
      authorFamily: remoteHeadFamily(db, task) ?? workflow.authorFamily,
      review: { round: review.round, verdict: review.verdict as "pass" | "changes", reviewerFamily: review.reviewerFamily, reportPath: review.reportPath,
        p2: review.findings.filter((f) => f.severity === "P2").length, reviewSeq: review.eventSeq } };
    const event = insertEvent(db, { actor: ctx.actor, now, dedupKey: key }, { project: task.project, target: task.id, kind: "scheduler",
      text: `合并交给仓库方：${input.pr} @ ${input.head.slice(0, 12)}`, data: { op: "merge_handoff", evidence } }, true);
    return { event, duplicate: false };
  });
}

/**
 * After the handoff the owner merged main into the PR (update-branch): the parents and that only main came in were checked
 * against the head followed so far (scheduler-main-merge-carry.ts), so this machine's review still covers the PR. The card's own
 * head stays the reviewed one; the PR head followed moves on, and a replay returns the first record.
 */
export function recordHandoffCarry(db: Database, ctx: WriteCtx, input: { taskId: string; head: string; pr: string; from: string; to: string;
  mainParent: string; mainHead: string; diffHash: string; basis: string }): { event: LedgerEvent; duplicate: boolean } {
  return tx(db, () => {
    const { task } = handoffCard(db, ctx, input);
    const follow = handoffOf(db, task);
    if (follow?.evidence.head !== input.head || follow.evidence.pr !== input.pr) throw new LedgerError("conflict", "这个 PR 和 head 没有交接记录");
    if (![input.from, input.to, input.mainParent, input.mainHead].every((s) => SHA.test(s)) || !/^[a-f0-9]{64}$/.test(input.diffHash)) {
      throw new LedgerError("invalid", "新 head、main 父提交、main 头要是完整 SHA，净 diff 要是 sha256");
    }
    if (!(CARRY_BASIS as readonly string[]).includes(input.basis)) throw new LedgerError("invalid", `--basis 只能是 ${CARRY_BASIS.join(" / ")}`);
    const key = `scheduler:${CARRY_OP}:${task.id}:h${follow.event.seq}:${input.from}:${input.to}`;
    const prev = getEventByDedup(db, key);
    if (prev) return { event: prev, duplicate: true };
    if (follow.head !== input.from || input.from === input.to) throw new LedgerError("conflict", `交接后跟的 PR head 是 ${follow.head.slice(0, 12)}，不是 ${input.from.slice(0, 12)}`);
    const event = insertEvent(db, { actor: ctx.actor, now: ctx.now ?? Date.now(), dedupKey: key }, { project: task.project, target: task.id, kind: "scheduler",
      text: `交接后 PR 只合入了 main：${input.from.slice(0, 12)} → ${input.to.slice(0, 12)}，${input.basis === "auto-merge" ? "新 head 就是自动合并结果" : "净 diff 不变"}，继续跟`,
      data: { op: CARRY_OP, handoffSeq: follow.event.seq, from: input.from, to: input.to, mainParent: input.mainParent,
        mainHead: input.mainHead, diffHash: input.diffHash, basis: input.basis } }, true);
    return { event, duplicate: false };
  });
}

/**
 * What the auto tick read before landing (scheduler-merge-handoff-tick.ts): the PR's base, its head when merged and the main commit
 * of the PR repository found to contain the merge commit. The writer rechecks it against the handoff it follows.
 */
export interface LandingProof { base: string; prHead: string; mainHead: string }

/** Refusal of a landing proof that does not match this handoff: only a merge into main, at the head followed, lands. */
function landingRefusal(follow: HandoffFollow, proof: LandingProof): LedgerError | null {
  if (proof.base !== "main") return new LedgerError("conflict", `PR 合进的是 ${proof.base || "（未知分支）"}，交接只认合进 main`);
  if (!SHA.test(proof.prHead) || !SHA.test(proof.mainHead)) return new LedgerError("invalid", "合并时的 PR head 和 main 头要是完整 SHA");
  if (proof.prHead.toLowerCase() !== follow.head.toLowerCase()) {
    return new LedgerError("conflict", `合并时的 PR head ${proof.prHead.slice(0, 12)} 不是交接后跟的 ${follow.head.slice(0, 12)}`);
  }
  return null;
}

/**
 * GitHub shows the handed-over PR merged at the head the handoff follows: the card moves merge → live with the merge commit. Only the
 * tick's checked `proof` (passed through the scheduler CLI's `--merged`) lands; a write without it is refused.
 */
export function landMergeHandoff(db: Database, ctx: WriteCtx, input: { taskId: string; head: string; pr: string; mergeSha: string; proof?: LandingProof }): LedgerTask {
  return tx(db, () => {
    const { task } = handoffCard(db, ctx, input);
    const follow = handoffOf(db, task);
    if (follow?.evidence.head !== input.head || follow.evidence.pr !== input.pr) throw new LedgerError("conflict", "这个 PR 和 head 没有交接记录");
    if (!SHA.test(input.mergeSha)) throw new LedgerError("invalid", "合并提交必须是完整 SHA");
    if (!input.proof) throw new LedgerError("invalid", "没有核对过的合入证据（base main、合并时 head、含合并提交的 main），不进 live");
    const refused = landingRefusal(follow, input.proof);
    if (refused) throw refused;
    const move = canTransition(task, "live", "pm");
    if (!move.ok) throw new LedgerError("conflict", move.reason);
    const now = ctx.now ?? Date.now(), next = nextTaskState(task, "live");
    db.prepare("UPDATE tasks SET stage=?, stageBefore=?, round=?, specRev=?, rev=rev+1, updatedAt=? WHERE id=?")
      .run(next.stage, next.stageBefore, next.round, next.specRev, now, task.id);
    // head = the PR head GitHub merged; a carried one names the reviewed head and the last carry it was reached by
    const carried = follow.carrySeq === null ? {} : { handedHead: follow.evidence.head, carrySeq: follow.carrySeq };
    const onMain = { base: input.proof.base, mainHead: input.proof.mainHead };
    insertEvent(db, { actor: ctx.actor, now }, { project: task.project, target: task.id, kind: "stage", text: `仓库方已合并 ${input.mergeSha.slice(0, 12)}，进入 live`,
      data: { from: "merge", to: "live", round: next.round, specRev: next.specRev, head: follow.head, mergeSha: input.mergeSha, handoffSeq: follow.event.seq, ...carried, ...onMain } }, false);
    // same release as every other move to live (ledger-write.ts): merged code no longer needs the card's file locks
    releaseFinishedCardLeases(db, task.id);
    return mustTask(db, task.id);
  });
}

/**
 * At the handoff the PR's net change is fixed, so the card keeps locks only on the files it actually changed that its fileGlobs
 * cover; the rest go back to other cards while the owner takes days to merge. A carry only merges main in (same net diff): locks
 * stay. Back in fix, the fix dispatch re-takes the full fileGlobs (planIntent acquires what it lacks, waiting on any card that took
 * a file meanwhile). tests/scheduler-merge-handoff-narrow.test.ts.
 */
const NARROW_OP = "merge_handoff_narrow";

export type NarrowResult = { narrowed: true; from: string[]; to: string[]; duplicate: boolean } | { narrowed: false; reason: string };

/**
 * `files` = the PR's changed paths (both sides of a rename) at the handed head, or why no rereading can give them. Any path the scheduler cannot name as a resource,
 * an open intent, or a card no longer at this handoff keeps the locks whole: narrowing is an optimisation, never a guess.
 */
const narrowKey = (taskId: string, handoffSeq: number): string => `scheduler:${NARROW_OP}:${taskId}:h${handoffSeq}`;

/** This handoff's narrowing is settled (locks narrowed, or skipped for a reason no retry changes): the tick stops asking for files. */
export const handoffNarrowSettled = (db: Database, taskId: string, handoffSeq: number): boolean => !!getEventByDedup(db, narrowKey(taskId, handoffSeq));

export function narrowHandoffLocks(db: Database, ctx: WriteCtx,
  input: { taskId: string; head: string; pr: string; files: readonly string[] | { refused: string } }): NarrowResult {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "交接收窄只由调度服务做");
  return tx(db, () => {
    const task = mustTask(db, input.taskId), follow = handoffOf(db, task);
    if (task.stage !== "merge" || !SHA.test(input.head) || task.headSHA !== input.head || follow?.evidence.head !== input.head || follow.evidence.pr !== input.pr) {
      return { narrowed: false, reason: "卡不在这次交接上（阶段、head 或 PR 已变）" };
    }
    const key = narrowKey(task.id, follow.event.seq), now = ctx.now ?? Date.now();
    const prev = getEventByDedup(db, key);
    if (prev) {
      return prev.data.skipped ? { narrowed: false, reason: String(prev.data.skipped) }
        : { narrowed: true, from: prev.data.from as string[], to: prev.data.to as string[], duplicate: true };
    }
    // an open intent settles on its own: no record, the next poll tries again
    if (db.query("SELECT 1 FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown') LIMIT 1").get(task.id)) {
      return { narrowed: false, reason: "卡还有未结调度意图" };
    }
    // the rest hold for this whole handoff: recorded once so the tick stops reading the PR's files for it
    const skip = (reason: string): NarrowResult => {
      insertEvent(db, { actor: ctx.actor, now, dedupKey: key }, { project: task.project, target: task.id, kind: "scheduler",
        text: `交接后文件锁不收窄：${reason}`, data: { op: NARROW_OP, handoffSeq: follow.event.seq, head: input.head, skipped: reason } }, true);
      return { narrowed: false, reason };
    };
    if ("refused" in input.files) return skip(input.files.refused);
    const held = cardFileLocks(db, task.id), target = narrowTarget(task, held, input.files, input.pr);
    if ("skipped" in target) return skip(target.skipped);
    const { from, to, paths, repo } = target;
    replaceCardFileLocks(db, task, held, to, now);
    insertEvent(db, { actor: ctx.actor, now, dedupKey: key }, { project: task.project, target: task.id, kind: "scheduler",
      text: narrowedText(from, to), data: { op: NARROW_OP, handoffSeq: follow.event.seq, head: input.head, from, to, files: paths, ...(repo ? { repo } : {}) } }, true);
    return { narrowed: true, from, to, duplicate: false };
  });
}

const narrowedText = (from: readonly string[], to: readonly string[]): string => `交接后文件锁收窄到 PR 实际改动：${from.length} → ${to.length} 把`;
const LOCK_REPO = /^repo:([\w.-]+\/[\w.-]+)\//;

/**
 * The narrowing itself, shared by the handoff and a private card's foreign_repo escalation (scheduler-merge-handoff-private.ts):
 * PR ∩ fileGlobs, and never a lock the card does not already cover — narrowing only ever gives files back. A card whose locks
 * carry `repo:<owner>/<name>/` (PRIVLOCK1) narrows only when every lock names the PR's own repository; its PR paths get that head.
 */
export type NarrowTarget = { from: string[]; to: string[]; paths: string[]; repo: string | null } | { skipped: string };
export function narrowTarget(task: LedgerTask, held: readonly FileLock[], files: readonly string[], pr: string): NarrowTarget {
  const repo = held.some((h) => h.resource.startsWith("repo:")) ? lockRepo(held, pr) : null;
  if (repo && "skipped" in repo) return repo;
  const head = repo ? `repo:${repo.repo}/` : "";
  const paths = files.map((f) => (f.includes("*") ? null : resourceKey(head + f)));
  if (paths.includes(null)) return { skipped: "PR 改动里有调度器认不了的路径" };
  const globs = Array.isArray(task.extra.fileGlobs) ? task.extra.fileGlobs.map((g) => (typeof g === "string" ? resourceKey(g) : null)) : [];
  if (!globs.length || globs.includes(null)) return { skipped: "卡的 fileGlobs 缺失或不合规" };
  if (!held.length) return { skipped: "卡没拿文件锁" };
  const to = [...new Set(paths as string[])].filter((p) => globs.some((g) => coveredBy(p, g!)) && held.some((h) => coveredBy(p, h.resource))).sort();
  return { from: held.map((h) => h.resource), to, paths: paths as string[], repo: repo?.repo ?? null };
}

/** The one repository every `repo:` lock names, when it is the PR's (case-insensitive); a bare lock mixed in or another repository refuses. */
function lockRepo(held: readonly FileLock[], pr: string): { repo: string } | { skipped: string } {
  const repos = new Set(held.map((h) => LOCK_REPO.exec(h.resource)?.[1]?.toLowerCase() ?? ""));
  if (repos.has("")) return { skipped: "卡的锁混了裸路径和 repo: 前缀" };
  const prRepo = prCoordinates(pr)?.repo.toLowerCase();
  if (repos.size !== 1) return { skipped: `卡的锁混了 ${repos.size} 个仓库` };
  const [repo] = repos as Set<string>;
  return prRepo === repo ? { repo } : { skipped: `卡的锁在 repo:${repo}，不是 PR 的仓库 ${prRepo ?? "（PR 链接不合规）"}` };
}

/**
 * dispatch-recovery-PRIVLOCK2 · the writes of a private card's merge-stage narrowing; scheduler-merge-handoff-private.ts reads the
 * PR and decides when. Kept here so the event write base stays with the writer modules. Each is rechecked in its own transaction:
 * a card that left this merge, head or PR, or got an open intent while the PR was read, is left alone and nothing is recorded.
 */
const PRIVATE_OP = "merge_private_narrow";
export type PrFiles = readonly string[] | { refused: string };
type PrivateInput = { taskId: string; head: string; pr: string | null; files: PrFiles };
export const privateNarrowKey = (taskId: string, head: string): string => `scheduler:${PRIVATE_OP}:${taskId}:${head}`;
export const openIntent = (db: Database, taskId: string): boolean =>
  !!db.query("SELECT 1 FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown') LIMIT 1").get(taskId);
const offPrivateMerge = (task: LedgerTask, input: PrivateInput): boolean =>
  task.stage !== "merge" || (task.headSHA ?? "none") !== input.head || task.pr !== input.pr;

/** on: the card's locks down to PR ∩ fileGlobs (narrowTarget), or one record of why not, once per (card, head). */
export function narrowPrivateLocks(db: Database, ctx: { now: number }, input: PrivateInput): NarrowResult {
  return tx(db, () => {
    const task = mustTask(db, input.taskId);
    if (offPrivateMerge(task, input)) return { narrowed: false, reason: "卡已不在这次 merge 上（阶段、head 或 PR 已变）" };
    const key = privateNarrowKey(task.id, input.head), repo = prCoordinates(task.pr)?.repo.toLowerCase() ?? null;
    const prev = getEventByDedup(db, key);
    if (prev) {
      return prev.data.skipped ? { narrowed: false, reason: String(prev.data.skipped) }
        : { narrowed: true, from: prev.data.from as string[], to: prev.data.to as string[], duplicate: true };
    }
    if (openIntent(db, task.id)) return { narrowed: false, reason: "卡还有未结调度意图" };
    const write = (text: string, data: Record<string, unknown>) => insertEvent(db, { actor: "scheduler", now: ctx.now, dedupKey: key },
      { project: task.project, target: task.id, kind: "scheduler", text, data: { op: PRIVATE_OP, head: input.head, repo, ...data } }, true);
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

/** observe: what on would do, one recovery note per (card, head) under `note`'s key; the locks stay as they are. */
export function observePrivateNarrow(db: Database, input: PrivateInput,
  note: Pick<ObservedAction, "project" | "mechanism" | "target" | "actionKey">, now: number): void {
  const { head, files } = input;
  tx(db, () => {
    const task = mustTask(db, input.taskId);
    if (offPrivateMerge(task, input) || openIntent(db, task.id)) return;
    const target = "refused" in files ? { skipped: files.refused } : narrowTarget(task, cardFileLocks(db, task.id), files, task.pr ?? "");
    const action = "skipped" in target ? `不收窄：${target.skipped}` : `收窄 ${target.from.length} → ${target.to.length} 把`;
    const data = "skipped" in target ? { head, skipped: target.skipped } : { head, from: target.from, to: target.to, repo: target.repo };
    recordObserved(db, { ...note, action, data }, now);
  });
}
