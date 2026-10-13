/**
 * CIRES1 · a card parked at merge by the bounce limit (or a merge retry) whose blocking bounce was cause=ci_fail goes back to auto
 * once the one re-run the ledger itself authorized (CIF1 / CIF8's merge_ci_rerun) went green on the same head. A RECBASE1 mechanism
 * (manual-recovery-release.ts): it only judges; the leased `scheduler-manual-resume --mechanism` reads GitHub and writes. It sends no
 * re-run, moves no stage, adds no review and leaves the bounce history as it is; the merge itself is the planner's and the driver's.
 * Key `ciManualResume`. Every refusal names who holds the card and what comes next. tests/manual-recovery-ci*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { activeKnownFlaky } from "./ci-known-flaky.js";
import { getIntent, type SchedulerIntent, type TaskWorkflow } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { ciSnapshotGap, readCiEvidence } from "./manual-recovery-ci-read.js";
import type { ExternalSnapshot, ManualRecoveryMechanism } from "./manual-recovery-release.js";
import { ciRerunSpent, TRAIN_RERUN_OP, TRAIN_RERUN_SEEN_OP } from "./scheduler-merge-ci-rerun.js";
import { BOUNCE_LIMIT_REASON } from "./scheduler-merge-conflict.js";
import { getMergeRun, mergeReviewProof } from "./scheduler-merge.js";
import { uiMergeRefusal } from "./scheduler-ui-merge-refusal.js";

export const CI_MANUAL_RESUME = "ci-manual-resume";
const RETRY = "merge_retry_requires_pm", LIMIT = "merge_bounce_limit";
const BOUNCE_OP = "merge_conflict", RERUN_OP = "merge_ci_rerun";
/** Anything that moves the mode or settles a journal after the entry is a person's (or another path's) move to finish. */
const TOUCHED_OPS: readonly string[] = ["workflow", "workflow_resume", "fallback_manual", "merge_resolve", "deploy_resolve"];
const RESUME_OPS: readonly string[] = ["workflow", "workflow_resume", "fallback_manual"];
const RUN = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/;

interface Claim {
  sub: string; intent: SchedulerIntent; rerun: LedgerEvent; run: string;
  required: string[]; claimed: string[]; kind: "timeout" | "known_flaky"; files: string[];
  /** every bounce on the card when judged: the proof covers these and no later one */
  bounces: number;
}
type Verdict<T> = ({ ok: true } & T) | { ok: false; why: string };
/** A refusal keeps the card where it is: PM's manual queue, its existing deadline, and the next step this gap needs. */
const gap = (why: string, next = "PM 核对后按人工队列处理"): { ok: false; why: string } =>
  ({ ok: false, why: `${why}；留人工队列（责任人 PM，期限照 manual 原有，下一步：${next}）` });
const eq = (a: unknown, b: unknown): boolean => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const isOp = (e: LedgerEvent, op: string): boolean => e.kind === "scheduler" && e.data.op === op;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && !!x);

/** The cancelled merge intent the manual entry stands on: named by a retry reason, the last escalated bounce for the limit. */
function blockedIntent(task: LedgerTask, events: readonly LedgerEvent[], entrySeq: number): Verdict<{ sub: string; id: string }> {
  const entry = events.find((e) => e.seq === entrySeq), d = entry?.data ?? {};
  const own = !!entry && isOp(entry, "fallback_manual") && entry.actor === "scheduler" && !!entry.dedupKey?.startsWith(`scheduler:fallback:${task.id}:w`);
  if (!own || d.from !== "auto" || [d.manual, d.hold].some((v) => v !== undefined) || d.imported === true) return gap("最初进 manual 的不是调度器从 auto 的正式退回");
  const reason = String(d.reason ?? ""), sub = /^([A-Za-z0-9_]+)\s*[:：]/.exec(reason)?.[1] ?? "";
  if (sub === RETRY) {
    const id = /^merge_retry_requires_pm：合并意图 (\S+) 已取消，/.exec(reason)?.[1];
    return id ? { ok: true, sub, id } : gap("退回理由没有指明被取消的合并意图");
  }
  if (sub !== LIMIT) return gap(`原子原因 ${sub || "不明"} 不是 ${RETRY} / ${LIMIT}`);
  if (reason !== `${LIMIT}：${BOUNCE_LIMIT_REASON}`) return gap("这次上限不是正式退回累计出来的（未发出取消），阻塞链没有 cause=ci_fail");
  const last = events.findLast((e) => e.seq < entrySeq && isOp(e, BOUNCE_OP) && e.data.escalated === true);
  return typeof last?.data.intentId === "string" ? { ok: true, sub, id: last.data.intentId } : gap("找不到触发上限的那次退回");
}

/** The bounce that ended the run, with its cause spelled out by the ledger, its settlement, and a journal that never sent a merge. */
function settledBounce(db: Database, task: LedgerTask, events: readonly LedgerEvent[], entrySeq: number, id: string):
  Verdict<{ intent: SchedulerIntent; bounce: LedgerEvent }> {
  const intent = getIntent(db, id);
  if (!intent || intent.taskId !== task.id || intent.project !== task.project || intent.action !== "merge" || intent.status !== "cancelled" ||
    intent.node === "manual_merge" || intent.specRev !== task.specRev || !eq(intent.head, task.headSHA)) return gap("阻塞链指的不是本卡当前规格和 head 上已取消的自动合并");
  const bounce = events.find((e) => e.dedupKey === `scheduler:${id}:merge:conflict`);
  if (!bounce || !isOp(bounce, BOUNCE_OP) || bounce.actor !== "scheduler" || bounce.data.intentId !== id || bounce.seq >= entrySeq) {
    return gap(`合并 ${id} 没有正式的退回记录，取消原因不明（unknown）`);
  }
  if (bounce.data.cause !== "ci_fail") return gap(`阻塞链的原因是 ${String(bounce.data.cause)}，不是 ci_fail`, "解冲突 / 更新分支后重新交付");
  if (!eq(bounce.data.prHead, task.headSHA)) return gap("退回的 head 不是卡上的 head");
  const settle = events.find((e) => e.seq === bounce.seq - 1);
  if (!settle || !isOp(settle, "settle") || settle.actor !== "scheduler" || settle.ts !== bounce.ts || settle.dedupKey !== `scheduler:${id}:cancelled` ||
    settle.data.id !== id || settle.data.to !== "cancelled" || settle.data.manual !== undefined) return gap(`合并 ${id} 的退回没有同一事务的正式结清`);
  const run = getMergeRun(db, id);
  if (!run || run.phase !== "resolved" || run.mergeSha || !eq(run.reviewedHead, task.headSHA) || run.prRef !== task.pr) return gap(`合并运行 ${id} 没有正式结清在当前 head / PR 上`);
  const sent = events.find((e) => isOp(e, "merge_phase") && e.data.intentId === id &&
    (e.actor !== "scheduler" || !!e.data.mergeSha || [e.data.phase, e.data.from, e.data.to].some((p) => p === "merging" || p === "merged" || p === "unknown")));
  if (sent) return gap(`合并 ${id} 的 journal 进过 merging / unknown 或有非调度器记录（#${sent.seq}），外部结果要人核对`, "scheduler-merge-resolve 凭外部回执结清");
  return { ok: true, intent, bounce };
}

/**
 * The one formal authorization: this intent's own merge_ci_rerun (CIF1 / CIF8 claim, written before `gh run rerun`), on this head,
 * for the run the bounce names. A run that merely shows attempt > 1, a green PR or a check name proves nothing about the first red.
 */
function authorizedRerun(db: Database, task: LedgerTask, events: readonly LedgerEvent[], intent: SchedulerIntent, bounce: LedgerEvent):
  Verdict<Pick<Claim, "rerun" | "run" | "claimed" | "kind" | "files">> {
  const next = "修复后重新交付，或 PM 走人工合并队列";
  const claims = events.filter((e) => isOp(e, RERUN_OP) && e.data.intentId === intent.id);
  const rerun = claims[0], d = rerun?.data ?? {};
  if (claims.length !== 1 || rerun.actor !== "scheduler" || !eq(d.prHead, task.headSHA) || rerun.dedupKey !== `scheduler:${intent.id}:merge:ci_rerun:${String(d.prHead)}` ||
    rerun.seq <= intent.eventSeq || rerun.seq >= bounce.seq || typeof d.run !== "string" || !RUN.test(d.run) || !strings(d.checks)) {
    return gap("这次合并没有 CIF1 / CIF8 的正式重跑授权（merge_ci_rerun）；attempt>1 或现在绿不能说明原失败是偶发", next);
  }
  const failed = bounce.data.checks as { name?: unknown; link?: unknown }[] | undefined;
  if (!Array.isArray(failed) || !failed.length || failed.some((c) => c.link !== d.run)) return gap("退回的失败检查不全在授权重跑的那个 run 上", next);
  const foreign = events.find((e) => e.kind === "note" && [TRAIN_RERUN_OP, TRAIN_RERUN_SEEN_OP].includes(String(e.data.op)) && eq(e.data.prHead, task.headSHA));
  if (foreign || ciRerunSpent(db, task.id, task.headSHA!)?.run !== d.run) return gap("这个 head 还有别的重跑记录（列车 / 人工），原失败归属不明", next);
  if (events.some((e) => isOp(e, "merge_ci_behind") && e.data.intentId === intent.id)) return gap("这次合并为 CI 红合入过 main，不是同 head 重跑", next);
  const listed = d.knownFlaky as { file?: unknown; entrySeq?: unknown }[] | undefined;
  if (listed === undefined) {
    if (!strings(d.cases)) return gap("重跑授权没有登记超时用例，首次失败无从对证", next);
    return { ok: true, rerun, run: d.run, claimed: d.checks, kind: "timeout", files: [...new Set(d.cases.map((c) => c.split(" > ")[0]!))] };
  }
  const active = activeKnownFlaky(db, task.project);
  const stale = !Array.isArray(listed) || !listed.length ? "（清单为空）" : listed.find((k) => typeof k.file !== "string" || active.get(k.file)?.seq !== k.entrySeq)?.file;
  if (stale !== undefined) return gap(`已知偶发条目 ${String(stale)} 已失效或被替换，授权时的依据不再成立`, "修复后重新交付，或 owner 重新登记已知偶发");
  return { ok: true, rerun, run: d.run, claimed: d.checks, kind: "known_flaky", files: listed.map((k) => k.file as string) };
}

/** Review, UI and spec as the merge gates read them today; nothing is carried, adopted or re-reviewed here. */
function gatesToday(db: Database, task: LedgerTask, workflow: TaskWorkflow): string | null {
  if (workflow.specRev !== task.specRev) return "流程的规格版本不是卡上的规格";
  try { mergeReviewProof(db, task, workflow); } catch (e) { return `现有审查闸不认：${(e as Error).message}`; }
  const ui = workflow.template === "ui" ? uiMergeRefusal(db, task, Date.now()) : null;
  return ui ? `现有截图闸不认：${ui}` : null;
}

/** Everything the ledger alone decides; the tick runs it before any GitHub read, the proof runs it again with the snapshot. */
function ledgerClaim(db: Database, task: LedgerTask, workflow: TaskWorkflow, events: readonly LedgerEvent[], entrySeq: number): Verdict<Claim> {
  if (task.stage !== "merge") return gap(`卡在 ${task.stage}，不跳阶段、不补审查`, "照常修复 / 审查，进 merge 后再判");
  if (!task.pr || !task.headSHA) return gap("卡上没有 PR 或 head");
  const blocked = blockedIntent(task, events, entrySeq);
  if (!blocked.ok) return blocked;
  const later = events.find((e) => e.seq > entrySeq && ((e.kind === "scheduler" && TOUCHED_OPS.includes(String(e.data.op))) || e.data.op === "manual_merge_request"));
  if (later) return gap(`进 manual 之后已有人工 / 流程动作（#${later.seq} ${String(later.data.op)}），不抢回`, "由 PM 完成自己的操作");
  const settled = settledBounce(db, task, events, entrySeq, blocked.id);
  if (!settled.ok) return settled;
  const { intent, bounce } = settled;
  const moved = events.find((e) => e.seq > intent.eventSeq && (e.kind === "stage" || e.kind === "deliver"));
  if (moved) return gap(`合并 ${intent.id} 规划之后卡又动过（#${moved.seq}），要新交付 / 新审查`, "照常修复、审查后重新进 merge");
  const auth = authorizedRerun(db, task, events, intent, bounce);
  if (!auth.ok) return auth;
  // A new manual episode must not spend an old hand-back again after PM or another path changes the mode.
  const spent = events.find((e) => {
    const proof = e.data.recoveryProof as { mechanism?: unknown; cancelIntentId?: unknown; evidenceSeq?: unknown } | undefined;
    return isOp(e, "workflow_resume") && e.actor === "scheduler" && proof?.mechanism === CI_MANUAL_RESUME &&
      (proof.cancelIntentId === intent.id || proof.evidenceSeq === auth.rerun.seq);
  });
  if (spent) return gap(`这次取消意图或 CI 重跑授权已交回过（#${spent.seq}），不能重复恢复`);
  const required = getMergeRun(db, intent.id)!.requiredChecks.split(",").filter(Boolean);
  if (!required.length || auth.claimed.some((c) => !required.includes(c))) return gap("重跑授权的检查不在这次合并的必过检查里");
  const gate = gatesToday(db, task, workflow);
  if (gate) return gap(gate, "补齐审查 / 截图验收后由 PM 交回");
  return { ...auth, sub: blocked.sub, intent, required, bounces: events.filter((e) => isOp(e, BOUNCE_OP)).length };
}

/** manualRecoveryTick's pre-check: the ledger-side gap, so a card that cannot qualify costs no GitHub read. */
export function ciLedgerGap(db: Database, task: LedgerTask, workflow: TaskWorkflow, events: readonly LedgerEvent[], entrySeq: number): string | null {
  const c = ledgerClaim(db, task, workflow, events, entrySeq);
  return c.ok ? null : c.why;
}

const episodeOf = (entrySeq: number, bounces: number): string => `e${entrySeq}.b${bounces}`;

function judge(db: Database, task: LedgerTask, workflow: TaskWorkflow, events: readonly LedgerEvent[], entrySeq: number,
  external: ExternalSnapshot | null): ReturnType<ManualRecoveryMechanism["judge"]> {
  const c = ledgerClaim(db, task, workflow, events, entrySeq);
  if (!c.ok) return c;
  const miss = ciSnapshotGap(external, { pr: task.pr!, head: task.headSHA!, required: c.required, claimed: c.claimed, run: c.run, kind: c.kind, files: c.files, now: Date.now() });
  if (miss) return gap(miss, "下一轮重读；仍不成立则修复后重新交付或走人工合并队列");
  return { ok: true, episodeId: episodeOf(entrySeq, c.bounces), subreason: c.sub, cancelIntentId: c.intent.id, evidenceSeq: c.rerun.seq, next: "merge" };
}

/**
 * Planner side (scheduler-plan.ts, in front of the bounce limit): the card's current mode is this mechanism's hand-back, bound to
 * this very cancelled intent and to the number of bounces the card had when it was proved. The seal itself is checked right after
 * by mergeRetryReleased (proofReleasesCancel); one more bounce, any later mode change or another intent, and the limit stands again.
 */
export function ciBounceSealed(events: readonly LedgerEvent[], cancelled: Pick<SchedulerIntent, "id">): boolean {
  const mode = events.findLast((e) => e.kind === "scheduler" && RESUME_OPS.includes(String(e.data.op)));
  const p = mode?.data.recoveryProof as { mechanism?: unknown; cancelIntentId?: unknown; episodeId?: unknown } | undefined;
  if (!mode || !p || mode.data.op !== "workflow_resume" || mode.actor !== "scheduler" || p.mechanism !== CI_MANUAL_RESUME || p.cancelIntentId !== cancelled.id) return false;
  const bounces = /^e\d+\.b(\d+)$/.exec(String(p.episodeId))?.[1];
  return bounces !== undefined && Number(bounces) === events.filter((e) => isOp(e, BOUNCE_OP)).length;
}

/** Registered by manual-recovery-release.ts. merge_unknown is shared with other causes; the judge takes only its own episodes. */
export const ciManualResume: ManualRecoveryMechanism = {
  id: CI_MANUAL_RESUME, key: "ciManualResume", codes: ["merge_unknown"], releasesCancel: true,
  readEvidence: (task) => readCiEvidence(task).catch((e) => { throw new Error(gap((e as Error).message, "下一轮重读；一直读不到由 PM 核对 GitHub").why); }),
  judge: (x) => judge(x.db, x.task, x.workflow, x.events, x.entrySeq, x.external),
};
