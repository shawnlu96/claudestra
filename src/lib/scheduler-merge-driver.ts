/** One bounded merge step per call. All external effects are preceded by a durable phase claim; `merged` is terminal. */
import { carryChainSuffix, type CarryHop } from "./review-main-carry-manual-auto.js";
import { carryReceipt, MERGE_UNKNOWN_WAIT, MERGE_UNKNOWN_CLEAR, type MergeRun, type MergePhase } from "./scheduler-merge.js";
import { bounceStep, updateOrBounce } from "./scheduler-merge-conflict.js";
import { behindUpdating } from "./scheduler-merge-ci-behind.js";
import { ciRed } from "./scheduler-merge-ci-carried.js";
import { redCheck } from "./scheduler-merge-ci-cancel-judge.js";
import { withCancelHandoff } from "./scheduler-merge-ci-cancel.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { movedHeadReceipt } from "./scheduler-review-rebase.js";
import { MERGE_NOT_SENT } from "./manual-merge-queue-facts.js";
import { foreignRepoReason, isForeignRepoError } from "./scheduler-foreign-repo.js";
import { noteContentCarry } from "./merge-content-review-sink.js";
import { mergeUnionStep } from "./scheduler-merge-union.js";
import { countCarryStep } from "./review-count-carry.js";
import { lightOnly } from "./ci-queue-full.js";
import { mainMovedSinceCi } from "./scheduler-merge-freshness.js";
import { withCiSelectedGate } from "./scheduler-ci-selected-gate.js";
import { ownerFreshEnd } from "./scheduler-ui-owner-fresh.js";

export interface PrSnapshot {
  state: "OPEN" | "MERGED" | "CLOSED";
  head: string;
  branch: string;
  crossRepository: boolean;
  base: string;
  draft: boolean;
  mergeState: string;
  mergeSha: string | null;
  checks: readonly { name: string; bucket: "pass" | "fail" | "pending" | "skipping" | "cancel"; link?: string }[];
  noChecks?: boolean; // MCHK1: gh said "no checks reported" for this head; mergeState is then UNKNOWN (a bounded wait)
}
/** How far `head` lags the current main; a failed lookup throws, it never reads as "up to date". */
export interface MainFreshness { behindBy: number; mainHead: string }
/** Whether a head moved by update-branch only merged main in; `ok` needs both the parent shape and a byte-identical net diff. */
export interface ReviewCarry { ok: boolean; reason: string; mainParent?: string; mainHead?: string; diffHash?: string; chain?: readonly CarryHop[] }
export interface MergeExternal {
  inspect(pr: string): Promise<PrSnapshot>;
  freshness(pr: string, head: string): Promise<MainFreshness>;
  carryReview(pr: string, oldHead: string, newHead: string): Promise<ReviewCarry>;
  updateBranch(pr: string): Promise<void>;
  merge(pr: string, expectedHead: string): Promise<string>;
  train?(run: MergeRun): Promise<"cleared" | "wait" | { bounce: string } | null>; // scheduler-merge-train.ts trainGate
  mainCi?(run: MergeRun): Promise<MainCiDecision>; // MAINCIW main CI gate, asked by scheduler-main-ci-wiring-driver.ts mainCiDrive
  fullRecheck?(run: MergeRun, pr: PrSnapshot): Promise<null | "wait" | string>; // scheduler-ci-full-request.ts: related-only green needs a full run
  proofWait?(run: MergeRun, pr: PrSnapshot): Promise<null | "wait" | string>; // scheduler-ci-proof-gate.ts: direct path only, asked before the claim
  /** mergeDirect on: the PR's own green CI + a clean merge suffice — no update-branch, no full re-check; main's post-merge CI judges the mix. */
  direct?(run: MergeRun): boolean;
  ciSelected?: boolean; // CISEL2: only the gh-backed external reads release receipts
  /** Pause between the direct path's UNKNOWN re-reads (tests pass 0). */
  unknownRereadMs?: number;
}
export type MainCiDecision = "go" | "wait" | { cancel: string };
export type MergeAdvance = (from: MergePhase, to: MergePhase, rev: number, receipt?: string, mergeSha?: string, newHead?: string) => Promise<MergeRun>;

const sameHead = (run: MergeRun, pr: PrSnapshot): boolean => pr.head.toLowerCase() === run.reviewedHead.toLowerCase();
/** This run's own open, non-draft, same-repo PR on main at the reviewed head. */
const samePr = (run: MergeRun, pr: PrSnapshot): boolean => pr.state === "OPEN" && sameHead(run, pr) && pr.branch === run.expectedBranch &&
  pr.base === "main" && !pr.draft && !pr.crossRepository;
/** MCRY3 at await_ci: only the head moved. No merge was sent (merging never returns here) and the scheduler's own update-branch was
 * already carried into reviewedHead, so this is the author's push. */
const authorPush = (run: MergeRun, pr: PrSnapshot): boolean => !sameHead(run, pr) && samePr({ ...run, reviewedHead: pr.head }, pr);
export const green = (run: Pick<MergeRun, "requiredChecks">, checks: PrSnapshot["checks"]): boolean =>
  run.requiredChecks.split(",").every((name) => checks.some((c) => c.name === name && c.bucket === "pass")) &&
  checks.every((c) => !redCheck(c) && c.bucket !== "pending") && !lightOnly(checks);
const short = (s: string) => s.slice(0, 12);
/** BEHIND only says main moved on; under mergeDirect that is not a reason to wait (GitHub still refuses a real conflict as DIRTY). */
const mergeable = (state: string, direct: boolean): boolean => state === "CLEAN" || (direct && state === "BEHIND");
const stopped = (e: unknown): boolean => e instanceof SchedulerStopped;
const failed = (checks: PrSnapshot["checks"]): boolean => checks.some(redCheck);
/** UNSTABLE = mergeable but some check isn't green yet (CI still running); a failed/cancelled check is a real anomaly. */
const unstableWait = (pr: PrSnapshot): "wait" | "failed" | null => pr.mergeState !== "UNSTABLE" ? null : failed(pr.checks) ? "failed" : "wait";
/** Re-reads the ledger for a reason the run may no longer merge (lib/scheduler-merge.ts mergeRunDrift); null = still valid. */
export type Recheck = (run: MergeRun) => string | null;
type Step = (to: MergePhase, receipt?: string, mergeSha?: string, newHead?: string) => Promise<MergeRun>;

/** GitHub leaves mergeability UNKNOWN for seconds to minutes after main moves; an unbroken streak past this is an anomaly. */
export const MERGE_STATE_UNKNOWN_LIMIT_MS = 10 * 60_000;
export const UNKNOWN_LIMIT_REASON = `GitHub 合并状态 ${MERGE_STATE_UNKNOWN_LIMIT_MS / 60_000} 分钟仍未算出`;
export const NO_CHECKS_LIMIT_REASON = `CI 在 ${MERGE_STATE_UNKNOWN_LIMIT_MS / 60_000} 分钟内没有登记`;
/** Any inspect that reads something other than a non-draft UNKNOWN ends the streak, so only consecutive UNKNOWNs count. */
function watchUnknown(current: () => MergeRun, external: MergeExternal, step: Step, seen: (pr: PrSnapshot) => void): MergeExternal {
  return { ...external, inspect: async (prRef) => {
    const pr = await external.inspect(prRef);
    seen(pr);
    const run = current();
    if ((pr.mergeState !== "UNKNOWN" || pr.draft) && run.unknownSince != null) await step(run.phase, MERGE_UNKNOWN_CLEAR);
    return pr;
  } };
}
/** MERGEFAST3: GitHub computes mergeability once asked, usually within seconds; with mergeDirect a few short re-reads of an
 * open PR beat waiting a whole pass (1–2 min on 10-13). A draft, a head with no checks reported or a closed PR is returned at once. */
export const UNKNOWN_REREADS = 3;
function rereadUnknown(external: MergeExternal, assertActive: () => void): MergeExternal {
  return { ...external, inspect: async (prRef) => {
    let pr = await external.inspect(prRef);
    for (let i = 0; i < UNKNOWN_REREADS && pr.state === "OPEN" && pr.mergeState === "UNKNOWN" && !pr.draft && !pr.noChecks; i++) {
      await Bun.sleep(external.unknownRereadMs ?? 3_000);
      assertActive();
      pr = await external.inspect(prRef);
    }
    return pr;
  } };
}
/** GitHub is still computing mergeability: stay in this phase and re-read next tick, until the limit turns it into unknown. */
async function unknownWait(run: MergeRun, step: Step): Promise<MergeRun> {
  // Judge the row the WAIT write returns: the journal keeps an existing start, so a stale read still meets the limit.
  const seen = run.unknownSince == null ? await step(run.phase, MERGE_UNKNOWN_WAIT) : run;
  if (seen.unknownSince == null || Date.now() - seen.unknownSince < MERGE_STATE_UNKNOWN_LIMIT_MS) return seen;
  return step("unknown", UNKNOWN_LIMIT_REASON);
}

/** A query failure or any mismatch is a refusal, so a carried review can only ever be narrower than a re-review. */
async function carryOf(run: MergeRun, external: MergeExternal, head: string): Promise<ReviewCarry> {
  try {
    return await external.carryReview(run.prRef, run.reviewedHead, head);
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    return { ok: false, reason: `核对失败：${(e as Error).message.slice(0, 200)}` };
  }
}

/** update-branch moved the head: keep the review only for a pure "merge main in" commit, else the old review is void. */
async function movedHead(run: MergeRun, external: MergeExternal, pr: PrSnapshot, step: Step): Promise<MergeRun> {
  const carry = await carryOf(run, external, pr.head);
  await noteContentCarry(run, pr.head, carry); // merge-arch-REVIEW1: PROOF1 evidence via the injected sink; never changes this path
  const back = (c: ReviewCarry) => step("await_review", movedHeadReceipt(run.reviewedHead, pr.head, c), undefined, pr.head); // scheduler-review-rebase.ts
  if (!carry.ok || !carry.mainParent || !carry.mainHead || !carry.diffHash) return (await countCarryStep(run, pr, step, back)) ?? back(carry); // CARRYCNT1
  const receipt = carryReceipt({ oldHead: run.reviewedHead, newHead: pr.head, mainParent: carry.mainParent,
    mainHead: carry.mainHead, diffHash: carry.diffHash }) + carryChainSuffix(carry.chain);
  const carrying = () => step("await_ci", receipt, undefined, pr.head);
  if (run.phase === "ready") {
    if (pr.draft) return run; // re-checked next round on the same evidence
    // MCRY2: the ledger carries only on an earlier attempt's own update-branch (scheduler-merge-ready-carry.ts), judged before any
    // CI / mergeability gate so a refused head goes back to review instead of freezing the queue; await_ci gates a carried one.
    const carried = await carrying().catch((e: unknown) => { // a drift refuses back() too, which then ends in the driver's unknown
      if (stopped(e)) throw e;
      return back({ ...carry, ok: false, reason: `跨尝试沿用被台账拒绝：${(e as Error).message.replace(/\s+/g, " ").slice(0, 200)}` });
    });
    return carried.phase === "await_ci" && pr.mergeState === "DIRTY" ? (await bounceStep(carried, pr, external, step)) ?? carried : carried;
  }
  // i28-CIF2's own update: a non-draft new head already red (UNSTABLE, BLOCKED or BEHIND) is carried, then bounced below
  const behind = behindUpdating(run) && !pr.draft && pr.mergeState !== "UNKNOWN" && failed(pr.checks);
  if ((pr.draft || pr.mergeState === "BEHIND") && !behind) return run; // re-checked next round on the same evidence
  if (pr.mergeState === "UNKNOWN") return unknownWait(run, step);
  // i28-CIF3: red on the scheduler's own update is carried, then bounced (required red) or waited out (gate not reported yet)
  if (unstableWait(pr) === "failed" && !behind && !ciRed(run, pr.checks)) return step("unknown", "更新分支后 CI 失败或取消");
  if (!["CLEAN", "UNSTABLE", "DIRTY"].includes(pr.mergeState) && !behind) return step("unknown", `更新分支后 mergeState=${pr.mergeState}`);
  const carried = await carrying();
  if (carried.phase !== "await_ci") return carried;
  // The carry made pr.head the reviewed head, so a conflict on it bounces through the same reviewed-head check as any other.
  return pr.mergeState === "DIRTY" || behind || ciRed(carried, pr.checks) === "required" ? (await bounceStep(carried, pr, external, step)) ?? carried : carried;
}

/** The last read is taken before the irreversible `merging` claim, so a transient UNKNOWN there still waits and a conflict
 * still bounces; after the claim only the head-pinned merge API runs (GitHub refuses a moved head, so nothing merges early).
 * `ciMain` (serial path only) is the main the green CI was read against, compared once more after the claim (MRGFRESH1). */
async function claimAndMerge(run: MergeRun, external: MergeExternal, step: Step, assertActive: () => void, trained = false,
  recheck: Recheck = () => null, direct = false, ciMain?: MainFreshness): Promise<MergeRun> {
  const ownerFresh = ownerFreshEnd(run); if (ownerFresh) return step("resolved", ownerFresh); // UIOWNCARRY2: up to date + green, never merged
  const fresh = await external.inspect(run.prRef);
  const same = samePr(run, fresh);
  if (same && fresh.mergeState === "UNKNOWN") return unknownWait(run, step);
  const bounced = await bounceStep(run, fresh, external, step);
  if (bounced) return bounced;
  if (!same || !mergeable(fresh.mergeState, direct) || !green(run, fresh.checks)) return step("unknown", "合并前最后一次核对发现 PR/head/CI 已变");
  if (trained && await external.train?.(run) !== "cleared") return run; // a train voided before the claim: no merge sent, retried next round
  const proof = direct && !trained ? await external.proofWait?.(run, fresh) : null; // "wait" = no full proof yet: nothing claimed; a cleared member keeps its car's proof
  if (proof) return proof === "wait" ? run : step("unknown", proof);
  const claimed = await step("merging", `CI 全绿：${fresh.checks.map((c) => c.name).join(", ").slice(0, 300)}`);
  assertActive();
  // MRGFRESH1: main may have moved while the claim was awaited. Nothing was sent, which the receipt says. The merge API pins only
  // the head, so the rest of the window is the repository's strict up-to-date / merge queue protection (scheduler-merge-freshness.ts).
  const moved = ciMain ? await mainMovedSinceCi(external, run, ciMain, assertActive) : null;
  if (moved) return step("unknown", `${MERGE_NOT_SENT}：${moved}`);
  // The claim's transaction re-read the ledger, but another write (a PM revoking the UI approval, the manual queue policy going off)
  // can commit before its receipt gets back here: re-read once more right before the irreversible call, marked as the one read that
  // knows the claim is still unsent (a `merging` row seen after a restart may have sent). Nothing was sent, which the receipt says.
  const drift = recheck({ ...claimed, beforeSend: true });
  if (drift) return step("unknown", `${MERGE_NOT_SENT}：${drift}`);
  const mergeSha = await external.merge(run.prRef, run.reviewedHead);
  if (!/^[a-f0-9]{40}$/i.test(mergeSha)) return step("unknown", "merge API 未确认完整合并 SHA");
  const merged = await external.inspect(run.prRef);
  if (merged.state !== "MERGED" || merged.base !== "main" || !sameHead(run, merged) || merged.mergeSha !== mergeSha) {
    return step("unknown", "合并后 PR 目标分支、head 或合并提交无法核实");
  }
  return step("merged", `PR 已合并 ${short(mergeSha)}，${(await import("./center-deploy-wording.js")).deployWording(run.project, "待 PM 部署", run.prRef)}`, mergeSha);
}

/** A related-only green needs the serial full re-check (scheduler-ci-full-request.ts) before the claim; a cleared train already ran full. */
async function fullThenMerge(run: MergeRun, pr: PrSnapshot, external: MergeExternal, step: Step, assertActive: () => void, trained: boolean,
  recheck: Recheck, ciMain: MainFreshness): Promise<MergeRun> {
  const full = trained ? null : await external.fullRecheck?.(run, pr);
  if (full) return full === "wait" ? run : step("unknown", full);
  return claimAndMerge(run, external, step, assertActive, trained, recheck, false, trained ? undefined : ciMain); // a train member keeps its car's joint proof
}

/** Gives the card to PM with a manual reason (scheduler-fallback-manual); wired by the merge tick. */
export type ForeignEscalate = (run: MergeRun, reason: string) => Promise<unknown>;

/**
 * i28-SECPOOL4: inspect refused the PR as another repository's. Before any merge was sent the card goes to PM (foreign_repo) first,
 * so the ledger ends this unknown as cancelled (manualCancel: slot freed, no freeze). null = not this path (no hook: the old
 * unknown); `failed` = the hand-over threw, which the driver's plain unknown then records.
 */
async function foreignEnd(e: unknown, current: () => MergeRun, step: Step, escalate?: ForeignEscalate): Promise<MergeRun | { failed: unknown } | null> {
  if (!escalate || !isForeignRepoError(e) || !["ready", "updating", "await_ci"].includes(current().phase)) return null;
  const reason = foreignRepoReason(e.prRepo);
  try {
    await escalate(current(), reason);
    return await step("unknown", `${MERGE_NOT_SENT}：${reason}`);
  } catch (failed) {
    if (stopped(failed) || ["unknown", "merged", "resolved"].includes(current().phase)) throw failed;
    return { failed };
  }
}

/** After update-branch: wait while GitHub still says BEHIND, then journal await_ci for the unchanged head. */
async function updatingStep(run: MergeRun, external: MergeExternal, step: Step): Promise<MergeRun> {
  const pr = await external.inspect(run.prRef);
  if (pr.state !== "OPEN" || pr.base !== "main" || pr.crossRepository || pr.branch !== run.expectedBranch) return step("unknown", "更新分支后 PR 状态、分支或 base 已变");
  if (!sameHead(run, pr)) return await movedHead(run, external, pr, step);
  if (pr.draft) return run;
  const bounced = await bounceStep(run, pr, external, step);
  if (bounced) return bounced;
  if (pr.mergeState === "BEHIND") return run; // GitHub 更新仍在进行，下一轮只读检查
  if (pr.mergeState === "UNKNOWN") return unknownWait(run, step);
  if (unstableWait(pr) === "failed") return step("unknown", "更新分支后 CI 失败或取消");
  if (pr.mergeState !== "CLEAN" && pr.mergeState !== "UNSTABLE") return step("unknown", `更新分支后 mergeState=${pr.mergeState}`);
  return step("await_ci", `head ${short(pr.head)} 未变，等待 CI`);
}

/** A merge was sent before a restart: only a verified merged PR counts, anything else is unknown and never re-sent. */
async function mergingStep(run: MergeRun, external: MergeExternal, step: Step): Promise<MergeRun> {
  const pr = await external.inspect(run.prRef);
  return pr.state === "MERGED" && pr.base === "main" && pr.mergeSha && /^[a-f0-9]{40}$/i.test(pr.mergeSha) && sameHead(run, pr)
    ? step("merged", `重启后核实 PR 已合并 ${short(pr.mergeSha)}，${(await import("./center-deploy-wording.js")).deployWording(run.project, "待 PM 部署", run.prRef)}`, pr.mergeSha)
    : step("unknown", "合并曾发出但未能核实结果，不重复 gh pr merge");
}

/** A changed head returns to review unless it only merged main in; an unobserved merge is never retried. */
export async function driveMerge(run: MergeRun, source: MergeExternal, advance: MergeAdvance,
  assertActive: () => void = () => {}, recheck: Recheck = () => null, foreign?: ForeignEscalate): Promise<MergeRun> {
  let noChecks = false; // the last read: a wait that expired on "no checks reported" says so
  const step = async (to: MergePhase, receipt?: string, mergeSha?: string, newHead?: string) => {
    assertActive();
    if (to === "unknown" && receipt === UNKNOWN_LIMIT_REASON && noChecks) receipt = NO_CHECKS_LIMIT_REASON;
    run = await advance(run.phase, to, run.rev, receipt, mergeSha, newHead);
    return run;
  };
  source = withCiSelectedGate(source, run); // merge-arch-CISEL2: a green released by the CI selected gate counts only under effective on
  const direct = source.direct?.(run) === true && !ownerFreshEnd(run); // UIOWNCARRY2: a fresh run always updates, mergeDirect never skips it
  const external = withCancelHandoff(watchUnknown(() => run, direct ? rereadUnknown(source, assertActive) : source, step, (pr) => { noChecks = pr.noChecks === true; }),
    foreign, MERGE_NOT_SENT, stopped); // CICANCEL1: a twice-cancelled CI goes to the PM through the same hook
  if (["merged", "unknown", "resolved", "await_review"].includes(run.phase)) return run;
  try {
    if (run.phase === "ready") {
      const pr = await external.inspect(run.prRef);
      if (pr.state !== "OPEN" || pr.crossRepository || pr.base !== "main" || pr.branch !== run.expectedBranch) {
        return step("unknown", `PR 状态、base 或审查 head 已变：${pr.state}/${pr.base}/${short(pr.head)}`);
      }
      // MCRY2: only the head moved (an earlier attempt's update-branch, or a push): carry or re-review, never a queue freeze.
      // Awaited so a refused fallback (the PM took the card over meanwhile) lands in the catch below and cancels via unknown.
      if (!sameHead(run, pr)) return await movedHead(run, external, pr, step);
      if (pr.draft) return run;
      const unioned = await mergeUnionStep(run, pr, external, step, direct, assertActive); if (unioned) return unioned; // KEYUNION1: union-only conflict
      const bounced = await bounceStep(run, pr, external, step);
      if (bounced) return bounced;
      if (pr.mergeState === "UNKNOWN") return unknownWait(run, step); // before update-branch: a stale UNKNOWN may yet read DIRTY and bounce
      const train = await external.train?.(run); // merge train: wait while it tests, bounce its culprit, skip update-branch once verified
      if (train && train !== "cleared") return train === "wait" ? run : step("resolved", train.bounce);
      // A red shard before the required verdict must wait without freezing or updating; GitHub says CLEAN for a stale branch, so freshness is asked.
      if (["CLEAN", "UNSTABLE", "BEHIND"].includes(pr.mergeState) && ciRed(run, pr.checks) === "unsettled") return run;
      if (!direct && train !== "cleared" && ((await external.freshness(run.prRef, pr.head)).behindBy > 0 || pr.mergeState === "BEHIND")) {
        const claimed = await step("updating");
        assertActive();
        return await updateOrBounce(claimed, external, step, stopped);
      }
      if (unstableWait(pr) === "failed") return step("unknown", "CI 失败或取消");
      if (!mergeable(pr.mergeState, direct) && pr.mergeState !== "UNSTABLE") return step("unknown", `PR mergeState=${pr.mergeState}`);
      const waiting = await step("await_ci", `PR ${short(pr.head)} 可合并，等待 CI${direct ? "（直接合：不追 main）" : ""}`); // a cleared or direct green member merges in this same call
      return (train === "cleared" || direct) && mergeable(pr.mergeState, direct) && green(waiting, pr.checks)
        ? await claimAndMerge(waiting, external, step, assertActive, train === "cleared", recheck, direct) : waiting;
    }
    if (run.phase === "updating") return await updatingStep(run, external, step);
    if (run.phase === "await_ci") {
      const pr = await external.inspect(run.prRef);
      // ready never journals await_ci for a draft, so a draft here is a change; UNSTABLE must not hide it behind the draft wait.
      if (pr.draft && pr.mergeState === "UNSTABLE") return step("unknown", "等 CI 时 PR 变成了 draft");
      const same = sameHead(run, pr) && pr.state === "OPEN" && !pr.crossRepository && pr.base === "main" && pr.branch === run.expectedBranch;
      if (same && pr.draft) return run;
      // MCRY3: void review, re-review, no freeze; before the train gate like a bounce (the train's own drift check voids it)
      if (authorPush(run, pr)) return await step("await_review", `等 CI 时作者推了新 head：原 head ${run.reviewedHead} → 新 head ${pr.head}，旧审查失效`, undefined, pr.head);
      if (same && pr.mergeState === "UNKNOWN") return unknownWait(run, step);
      // main moved during CI: the run tested another merge result (the journal caps how often). Awaited at the call
      // sites so a refused 4th refresh lands in the catch below and becomes unknown instead of escaping.
      const refresh = async (why: string) => {
        const claimed = await step("updating", `${why}，重新更新分支`);
        assertActive();
        return await updateOrBounce(claimed, external, step, stopped);
      };
      const bounced = await bounceStep(run, pr, external, step);
      if (bounced) return bounced;
      const unsettled = ciRed(run, pr.checks) === "unsettled"; // i28-CIF3: a shard is red before the required gate ran; bounceStep takes its verdict
      const train = await external.train?.(run); // any member that got here (from ready or updating) obeys its train before update / merge
      if (train && train !== "cleared") return train === "wait" ? run : step("resolved", train.bounce);
      if (!direct && train !== "cleared" && pr.mergeState === "BEHIND" && sameHead(run, pr) && pr.state === "OPEN" && !pr.draft && !pr.crossRepository &&
        pr.base === "main" && pr.branch === run.expectedBranch) return failed(pr.checks) ? unsettled ? run : step("unknown", "CI 失败或取消") : await refresh("等 CI 期间 GitHub 报 BEHIND");
      const unstable = unstableWait(pr); // The final pre-merge check below still demands CLEAN, so waiting here never merges early.
      if (unstable && sameHead(run, pr) && pr.state === "OPEN" && !pr.draft && !pr.crossRepository &&
        pr.base === "main" && pr.branch === run.expectedBranch) return unstable === "wait" || unsettled ? run : step("unknown", "CI 失败或取消");
      if (!sameHead(run, pr) || pr.state !== "OPEN" || pr.draft || pr.crossRepository || pr.base !== "main" || pr.branch !== run.expectedBranch ||
        !mergeable(pr.mergeState, direct)) {
        return step("unknown", "CI 前 PR/head/base/mergeability 变了");
      }
      if (failed(pr.checks)) return unsettled ? run : step("unknown", "CI 失败或取消"); // CLEAN can't hide a shard red before the gate
      if (!green(run, pr.checks)) return run;
      if (direct) return await claimAndMerge(run, external, step, assertActive, train === "cleared", recheck, true); // no freshness, no full re-check
      const stale = await external.freshness(run.prRef, pr.head); // GitHub keeps saying CLEAN for a stale branch; a train clearance is re-asked after it
      if (stale.behindBy > 0 && (train !== "cleared" || await external.train?.(run) !== "cleared")) return await refresh(`等 CI 期间 main 前进到 ${short(stale.mainHead)}，落后 ${stale.behindBy} 个提交`);
      return await fullThenMerge(run, pr, external, step, assertActive, train === "cleared", recheck, stale);
    }
    if (run.phase === "merging") return await mergingStep(run, external, step);
    return run;
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e; // Shutdown or lost ownership leaves the journal for the new controller to reconcile.
    if (["unknown", "merged", "resolved"].includes(run.phase)) throw e;
    const handed = await foreignEnd(e, () => run, step, foreign); if (handed) { if ("phase" in handed) return handed; e = handed.failed; } // i28-SECPOOL4
    return step("unknown", `外部步骤失败：${(e as Error).message.replace(/\s+/g, " ").slice(0, 450)}`);
  }
}
