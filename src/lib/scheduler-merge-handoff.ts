/**
 * Merge handoff (MHO1, docs/architecture/merge-handoff.md): in a project whose scheduler.json says `mergeHandoff`, the
 * repository owner merges. An auto card in `merge` is handed over with this machine's review evidence instead of entering the
 * merge queue, and moves to live only once GitHub shows its PR merged at the handed-over head, or at one reached from it only by
 * merging main in (each hop a carry record). Nothing here talks to GitHub: the auto tick reads the PR
 * (scheduler-merge-handoff-tick.ts) and these writes recheck the ledger in their own transaction.
 */
import type { Database } from "bun:sqlite";
import { isManager, mustTask, type WriteCtx } from "./ledger-checks.js";
import { getWorkflow, resourceKey, type AuthorFamily, type TaskWorkflow, type WorkflowTemplate } from "./ledger-scheduler.js";
import { canTransition, nextTaskState, type LedgerEvent, type LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getMeta, LedgerError, listEvents, putHandoffHold, type HandoffHold, type LedgerMeta } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { releaseFinishedCardLeases } from "./ledger-scheduler-lease.js";
import { cardFileLocks, coveredBy, replaceCardFileLocks } from "./ledger-scheduler-lease-sync.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { mergeReviewProof } from "./scheduler-merge.js";
import { uiMergeRefusal } from "./scheduler-ui-merge-refusal.js";
import { featureGate, handoffGateFacts } from "./handoff-gate.js";
import { batchHanded, batchPending, featureBatch, handoffGateWait, mergeEntry, nodeLabel } from "./handoff-gate-plan.js";
import { withLedgerWriter } from "./ledger-scheduler-lease-sync.js";

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
  /** A card on a feature DAG node goes out with its batch: every node in `merge` as card@head, dependencies first (handoff-gate.ts). */
  feature?: { id: string; version: number; batch: string[] };
}

const SHA = /^[a-f0-9]{40}$/i;
const CARRY_OP = "merge_handoff_carry";
/** How a carry was proved (scheduler-main-merge-carry.ts): the new tree is git's clean merge, or the net diff is byte-identical. */
const CARRY_BASIS = ["auto-merge", "net-diff"] as const;
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/;

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
function handoffCard(db: Database, ctx: WriteCtx, input: { taskId: string; head: string; pr: string }): { task: LedgerTask; workflow: TaskWorkflow } {
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
    const gates = handoffGateFacts(db, task), held = handoffGateWait(gates); // a replay of a recorded handoff returned above
    if (held) throw new LedgerError("conflict", `${held.code}：${held.reason}`);
    const now = ctx.now ?? Date.now();
    const ui = workflow.template === "ui" ? uiMergeRefusal(db, task, now) : null;
    if (ui) throw new LedgerError("conflict", ui);
    const review = mergeReviewProof(db, task, workflow);
    if (review.head !== input.head) throw new LedgerError("conflict", "审查结论不是这个 head 的");
    const evidence: HandoffEvidence = { v: 1, pr: input.pr, head: input.head, specRev: task.specRev, template: workflow.template,
      authorFamily: remoteHeadFamily(db, task) ?? workflow.authorFamily,
      review: { round: review.round, verdict: review.verdict as "pass" | "changes", reviewerFamily: review.reviewerFamily, reportPath: review.reportPath,
        p2: review.findings.filter((f) => f.severity === "P2").length, reviewSeq: review.eventSeq },
      ...(gates.feature ? { feature: { id: gates.feature.featureId, version: gates.feature.version, batch: featureBatch(gates.feature) } } : {}) };
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

/** GitHub shows the handed-over PR merged at the head the handoff follows: the card moves merge → live with the merge commit. */
export function landMergeHandoff(db: Database, ctx: WriteCtx, input: { taskId: string; head: string; pr: string; mergeSha: string }): LedgerTask {
  return tx(db, () => {
    const { task } = handoffCard(db, ctx, input);
    const follow = handoffOf(db, task);
    if (follow?.evidence.head !== input.head || follow.evidence.pr !== input.pr) throw new LedgerError("conflict", "这个 PR 和 head 没有交接记录");
    if (!SHA.test(input.mergeSha)) throw new LedgerError("invalid", "合并提交必须是完整 SHA");
    const move = canTransition(task, "live", "pm");
    if (!move.ok) throw new LedgerError("conflict", move.reason);
    const now = ctx.now ?? Date.now(), next = nextTaskState(task, "live");
    db.prepare("UPDATE tasks SET stage=?, stageBefore=?, round=?, specRev=?, rev=rev+1, updatedAt=? WHERE id=?")
      .run(next.stage, next.stageBefore, next.round, next.specRev, now, task.id);
    // head = the PR head GitHub merged; a carried one names the reviewed head and the last carry it was reached by
    const carried = follow.carrySeq === null ? {} : { handedHead: follow.evidence.head, carrySeq: follow.carrySeq };
    insertEvent(db, { actor: ctx.actor, now }, { project: task.project, target: task.id, kind: "stage", text: `仓库方已合并 ${input.mergeSha.slice(0, 12)}，进入 live`,
      data: { from: "merge", to: "live", round: next.round, specRev: next.specRev, head: follow.head, mergeSha: input.mergeSha, handoffSeq: follow.event.seq, ...carried } }, false);
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
    const paths = input.files.map((f) => (f.includes("*") ? null : resourceKey(f)));
    if (paths.includes(null)) return skip("PR 改动里有调度器认不了的路径");
    const globs = Array.isArray(task.extra.fileGlobs) ? task.extra.fileGlobs.map((g) => (typeof g === "string" ? resourceKey(g) : null)) : [];
    if (!globs.length || globs.includes(null)) return skip("卡的 fileGlobs 缺失或不合规");
    const held = cardFileLocks(db, task.id);
    if (!held.length) return skip("卡没拿文件锁");
    // PR ∩ fileGlobs, and never a lock the card does not already cover: narrowing only ever gives files back
    const to = [...new Set(paths as string[])].filter((p) => globs.some((g) => coveredBy(p, g!)) && held.some((h) => coveredBy(p, h.resource))).sort();
    const from = held.map((h) => h.resource);
    replaceCardFileLocks(db, task, held, to, now);
    insertEvent(db, { actor: ctx.actor, now, dedupKey: key }, { project: task.project, target: task.id, kind: "scheduler",
      text: `交接后文件锁收窄到 PR 实际改动：${from.length} → ${to.length} 把`, data: { op: NARROW_OP, handoffSeq: follow.event.seq, head: input.head, from, to, files: paths } }, true);
    return { narrowed: true, from, to, duplicate: false };
  });
}

/** `ledger handoff-hold <project> on|off`: PM / master / owner only; the reason and who / when stay in the project meta. */
export function setHandoffHold(db: Database, ctx: WriteCtx, input: { project: string; on: boolean; reason: string }): { meta: LedgerMeta; event: LedgerEvent } {
  return tx(db, () => {
    if (!isManager(db, ctx.actor, { agent: null, project: input.project })) throw new LedgerError("forbidden", `暂停交接要项目 ${input.project} 的 PM / master / owner（你是 ${ctx.actor}）`);
    if (input.on && !input.reason.trim()) throw new LedgerError("invalid", "打开暂停交接要写 --reason");
    if (getMeta(db, input.project).handoffHold.on === input.on) {
      throw new LedgerError("conflict", `项目 ${input.project} 的暂停交接已经是${input.on ? "开" : "关"}着的`);
    }
    const now = ctx.now ?? Date.now();
    const hold: HandoffHold = { on: input.on, reason: input.reason, by: ctx.actor, since: now };
    putHandoffHold(db, input.project, hold);
    const event = insertEvent(db, ctx, { project: input.project, target: "", kind: "meta", text: input.reason,
      data: { op: "set", patch: { handoffHold: hold } } }, true);
    return { meta: getMeta(db, input.project), event };
  });
}

/**
 * HDG-1 #7: part of a feature batch is already with the repository owner and a sibling of that batch is no longer reviewed
 * (back in fix / review, or a node added since). The rest keep waiting (handoff-gate-plan.ts) and nothing handed is recalled; PM
 * hears once per regression — the escalate event's dedup key names each pending sibling at its stage and round.
 * Records the escalation and returns its text the first time; null when nothing regressed or PM already heard of it.
 * tests/handoff-gate-tick.test.ts.
 */
export function recordFeatureRegress(db: Database, task: LedgerTask, now: number): string | null {
  const f = featureGate(db, task);
  const pending = f ? batchPending(f) : [], handed = f ? batchHanded(f) : [];
  if (!f || !pending.length || !handed.length) return null;
  const key = `handoff-gate:regress:${f.featureId}:${pending.map((n) => `${n.key}=${n.taskId ?? "planned"}:${n.stage}:r${n.round ?? 0}`).join(",")}`;
  const text = `[调度引擎] feature ${f.featureId} 已交出 ${handed.map((n) => `${n.taskId}@${(n.head ?? "").slice(0, 12)}`).join("、")}，` +
    `同批的 ${pending.map(nodeLabel).join("、")} 又没审过：同批其余的继续等，已交出的不自动撤回，要不要请仓库方暂缓合并由 PM 定`;
  return withLedgerWriter(db, (w) => tx(w, () => {
    if (getEventByDedup(w, key)) return null;
    insertEvent(w, { actor: "scheduler", now, dedupKey: key }, { project: task.project, target: task.id, kind: "escalate", text,
      data: { to: "pm", reason: text, auto: true, op: "feature_handoff_regress", featureId: f.featureId,
        handed: handed.map((n) => `${n.taskId}@${n.head ?? ""}`), pending: pending.map((n) => n.key) } }, true);
    return text;
  }));
}
