/**
 * UIRES1 · hand a UI card back to auto once the screenshot approval it went manual for exists. A RECBASE1 mechanism
 * (manual-recovery-release.ts): it only judges; the hand-back is still the leased `scheduler-manual-resume --mechanism`, which
 * re-proves in its transaction and asks the planner (with the sealed proof in view) what comes next, refusing an escalate.
 * Key `uiManualResume` (with the umbrella manualRecovery): off / observe / on, observe unless both are `on` explicitly.
 * - Episode: the scheduler's own fallback from auto (never a PM takeover, hold or import) whose planner code is a screenshot
 *   one (missing / stale / unapproved at merge), or merge_retry_requires_pm for a merge the journal ended as "never sent, only
 *   the screenshot gate blocked" (uiUnsentEnd's terminal, scheduler-ui-review-carry.ts); that cancelled intent is then bound.
 * - Evidence: PM's ui_approved, re-read through the existing gate (uiMergeRefusal: writer's permission, head / specRev / round /
 *   digest or the scheduler's carried chain, ownerVisual needing the owner), and a passing review bound to the card's head.
 *   Nothing here approves, shoots, carries or adopts a review source: the planner's own gates judge the source after the seal.
 * - Never: a card still in fix, a mode change or a manual merge request after the entry, a missing / rejected / unverified
 *   approval, a real unknown. The shared refusals (holds, asks, open intents, merge / deploy journals, drift) are RECBASE1's.
 * tests/manual-recovery-ui*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { getIntent, type SchedulerIntent, type TaskWorkflow } from "./ledger-scheduler.js";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { projectPmUiGate } from "./ledger-ui-approve-verdict.js";
import type { ManualRecoveryMechanism } from "./manual-recovery-release.js";
import type { ManualReasonRecord } from "./manual-reason.js";
import { currentReviewFacts } from "./scheduler-review.js";
import { uiMergeRefusal } from "./scheduler-ui-merge-refusal.js";

export const UI_MANUAL_RESUME = "ui-manual-resume";
/** Planner codes for "the screenshots or their approval are missing / stale"; a rejection or an unverified answer is a person's. */
const UI_SUBREASONS: readonly string[] = ["ui_missing_screenshots", "ui_stale", "merge_ui_unapproved"];
const MERGE_RETRY = "merge_retry_requires_pm";
const MODE_OPS: readonly string[] = ["workflow", "workflow_resume", "fallback_manual", "merge_resolve", "deploy_resolve"];
const REQUEST_OP = "manual_merge_request"; // manual-merge-queue-facts.ts (it imports the UI gate's callers, so not imported here)
const MANUAL_MERGE_NODE = "manual_merge";
const INTENT_ID = /^[\w.:@/-]{1,120}$/;

type Verdict<T> = ({ ok: true } & T) | { ok: false; why: string };
const no = (why: string): { ok: false; why: string } => ({ ok: false, why });
const sameSha = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const ofIntent = (e: LedgerEvent, id: string, op: string): boolean => e.kind === "scheduler" && e.data.op === op && e.data.intentId === id;

/** The formal entry: the scheduler's fallback out of auto, with the planner code its reason starts with. */
function episode(task: LedgerTask, events: readonly LedgerEvent[], entrySeq: number): Verdict<{ entry: LedgerEvent; code: string; sub: string; reason: string }> {
  const entry = events.find((e) => e.seq === entrySeq), d = entry?.data;
  if (!entry || entry.kind !== "scheduler" || entry.actor !== "scheduler" || d!.op !== "fallback_manual" || d!.from !== "auto" ||
    d!.manual !== undefined || d!.hold !== undefined || d!.imported === true || !entry.dedupKey?.startsWith(`scheduler:fallback:${task.id}:w`)) {
    return no("进 manual 的不是调度器从 auto 的正式退回");
  }
  const reason = typeof d!.reason === "string" ? d!.reason : "", sub = /^([A-Za-z0-9_]+)\s*[:：]/.exec(reason)?.[1];
  const code = (d!.manualReason as ManualReasonRecord | undefined)?.code;
  if (!sub || !code) return no("退回理由没有规划器的子原因码");
  return { ok: true, entry, code, sub, reason };
}

/** Nothing a person did to the mode or the manual queue since the entry: their move is theirs to finish. */
function peopleSince(events: readonly LedgerEvent[], entrySeq: number): string | null {
  const later = events.filter((e) => e.seq > entrySeq);
  const mode = later.find((e) => e.kind === "scheduler" && MODE_OPS.includes(String(e.data.op)));
  if (mode) return `进 manual 之后流程又被动过（#${mode.seq} ${String(mode.data.op)}），留给 PM`;
  const request = later.find((e) => e.kind === "decision" && e.data.op === REQUEST_OP);
  return request ? `进 manual 之后有人工合并请求 #${request.seq}，不抢人工` : null;
}

/**
 * merge_retry_requires_pm stands on one cancelled merge intent. It is bound only when the journal itself says no merge went out
 * and the screenshot gate was the one blocker: uiUnsentEnd's settle + terminal pair (same writer, same instant, their own dedup
 * keys), no merged phase or merge sha anywhere on the run, and the card unmoved since (same stage, head and spec).
 */
function unsentUiCancel(db: Database, task: LedgerTask, events: readonly LedgerEvent[], entry: LedgerEvent, reason: string): Verdict<{ intent: SchedulerIntent }> {
  const id = new RegExp(`^${MERGE_RETRY}：合并意图 (\\S+) 已取消，`).exec(reason)?.[1];
  const intent = id && INTENT_ID.test(id) ? getIntent(db, id) : null;
  if (!intent || intent.taskId !== task.id || intent.project !== task.project || intent.action !== "merge" || intent.status !== "cancelled" ||
    intent.node === MANUAL_MERGE_NODE || intent.specRev !== task.specRev) return no("退回理由指的不是本卡本规格已取消的自动合并意图");
  if (task.stage !== "merge" || !sameSha(intent.head, task.headSHA)) return no("被取消合并的 head 不是卡上的 head，或卡已不在 merge");
  const phases = events.filter((e) => ofIntent(e, intent.id, "merge_phase"));
  const terminal = phases.at(-1), settle = terminal && events.find((e) => e.seq === terminal.seq - 1);
  if (!terminal || terminal.seq >= entry.seq || terminal.actor !== "scheduler" || terminal.dedupKey !== `scheduler:${intent.id}:merge:cancelled` ||
    terminal.data.to !== "resolved" || terminal.data.outcome !== "cancelled" || terminal.data.uiUnsent !== true) {
    return no(`合并 ${intent.id} 不是「未发出、唯一阻塞是截图验收」的正式取消（可能已发出或结果不明），交 PM 核对`);
  }
  if (!settle || settle.kind !== "scheduler" || settle.actor !== "scheduler" || settle.ts !== terminal.ts || settle.data.op !== "settle" ||
    settle.dedupKey !== `scheduler:${intent.id}:cancelled` || settle.data.id !== intent.id || settle.data.from !== "submitted" ||
    settle.data.to !== "cancelled" || settle.data.manual !== undefined) return no(`合并 ${intent.id} 的取消没有同一事务的正式结清`);
  if (phases.some((e) => [e.data.phase, e.data.from, e.data.to].includes("merged") || !!e.data.mergeSha || e.actor !== "scheduler")) {
    return no(`合并 ${intent.id} 的 journal 里有已合并 / 非调度器的记录`);
  }
  const moved = events.find((e) => e.seq > intent.eventSeq && (e.kind === "stage" || e.kind === "deliver"));
  return moved ? no(`合并 ${intent.id} 规划之后卡又动过（#${moved.seq}）`) : { ok: true, intent };
}

/** PM's approval as the existing gate reads it today; the seq is the evidence the proof stands on. */
function approval(db: Database, task: LedgerTask, events: readonly LedgerEvent[]): Verdict<{ seq: number }> {
  const pm = projectPmUiGate(db, task, events);
  if (pm.state !== "approved" || pm.seq === undefined) return no(pm.state === "rejected" ? "PM 最后一条截图结论是未通过" : "还没有 PM 的截图批准（ui_approved）");
  if (pm.specRev !== task.specRev || pm.round !== task.round || pm.screenshotsDigest !== task.extra.screenshotsDigest) {
    return no("PM 的截图批准不在当前规格 / 轮次 / 截图摘要上");
  }
  // the gate re-checks the writer's permission, the head (or the scheduler's carried chain) and ownerVisual needing the owner
  const gate = uiMergeRefusal(db, task, Date.now());
  return gate ? no(`现有截图闸不认：${gate}`) : { ok: true, seq: pm.seq };
}

/** A passing review bound to the card's head must exist; whether its source is accepted is the planner's gate after the seal. */
function reviewPassed(db: Database, task: LedgerTask, events: readonly LedgerEvent[]): string | null {
  const read = currentReviewFacts(task, events, (a) => actorMayConfigure(db, a, task.project));
  if (read.kind !== "facts") return `缺本轮同 head 的审查结论${read.kind === "invalid" ? `（${read.reason}）` : ""}`;
  const f = read.facts;
  const open = f.verdict === "block" || f.findings.some((x) => x.severity === "P0" || x.severity === "P1") ||
    (f.verdict === "changes" && !f.findings.some((x) => x.severity === "P2"));
  return open ? `审查结论 #${f.eventSeq} 还没通过，仍要修复` : null;
}

function judge(db: Database, task: LedgerTask, workflow: TaskWorkflow, events: readonly LedgerEvent[], entrySeq: number): ReturnType<ManualRecoveryMechanism["judge"]> {
  if (workflow.template !== "ui") return no("不是 ui 模板的卡");
  if (task.stage !== "review" && task.stage !== "merge") return no(`卡在 ${task.stage}，补图 / 修复不由本机制跳过`);
  const ep = episode(task, events, entrySeq);
  if (!ep.ok) return ep;
  const stale = ep.code === "ui_evidence_stale" && UI_SUBREASONS.includes(ep.sub), retry = ep.code === "merge_unknown" && ep.sub === MERGE_RETRY;
  if (!stale && !retry) return no(`子原因 ${ep.sub} 不是截图缺失 / 失效，也不是只差截图验收的合并重试`);
  const people = peopleSince(events, entrySeq);
  if (people) return no(people);
  const cancel = retry ? unsentUiCancel(db, task, events, ep.entry, ep.reason) : null;
  if (cancel && !cancel.ok) return cancel;
  const ok = approval(db, task, events);
  if (!ok.ok) return ok;
  const review = reviewPassed(db, task, events);
  if (review) return no(review);
  return { ok: true, episodeId: `e${entrySeq}`, subreason: ep.sub, cancelIntentId: cancel?.ok ? cancel.intent.id : null, evidenceSeq: ok.seq,
    next: task.stage === "merge" ? "merge" : "review-to-merge" };
}

/** Registered by manual-recovery-release.ts. Both listed codes are shared with other causes; the judge takes only its own episodes. */
export const uiManualResume: ManualRecoveryMechanism = {
  id: UI_MANUAL_RESUME, key: "uiManualResume", codes: ["ui_evidence_stale", "merge_unknown"], releasesCancel: true,
  judge: (x) => judge(x.db, x.task, x.workflow, x.events, x.entrySeq),
};
