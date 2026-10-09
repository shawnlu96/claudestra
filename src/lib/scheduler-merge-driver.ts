/** One bounded merge step per call. All external effects are preceded by a durable phase claim; `merged` is terminal. */
import { carryChainSuffix, type CarryHop } from "./review-main-carry-manual-auto.js";
import { carryReceipt, MERGE_UNKNOWN_WAIT, MERGE_UNKNOWN_CLEAR, type MergeRun, type MergePhase } from "./scheduler-merge.js";
import { bounceStep, updateOrBounce } from "./scheduler-merge-conflict.js";
import { behindUpdating } from "./scheduler-merge-ci-behind.js";
import { ciRed } from "./scheduler-merge-ci-carried.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { movedHeadReceipt } from "./scheduler-review-rebase.js";
import { MERGE_NOT_SENT } from "./manual-merge-queue-facts.js";

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
}
export type MergeAdvance = (from: MergePhase, to: MergePhase, rev: number, receipt?: string, mergeSha?: string, newHead?: string) => Promise<MergeRun>;

const sameHead = (run: MergeRun, pr: PrSnapshot): boolean => pr.head.toLowerCase() === run.reviewedHead.toLowerCase();
/** This run's own open, non-draft, same-repo PR on main at the reviewed head. */
const samePr = (run: MergeRun, pr: PrSnapshot): boolean => pr.state === "OPEN" && sameHead(run, pr) && pr.branch === run.expectedBranch &&
  pr.base === "main" && !pr.draft && !pr.crossRepository;
/** MCRY3 at await_ci: only the head moved. No merge was sent (merging never returns here) and the scheduler's own update-branch was
 * already carried into reviewedHead, so this is the author's push. */
const authorPush = (run: MergeRun, pr: PrSnapshot): boolean => !sameHead(run, pr) && samePr({ ...run, reviewedHead: pr.head }, pr);
const green = (run: MergeRun, checks: PrSnapshot["checks"]): boolean =>
  run.requiredChecks.split(",").every((name) => checks.some((c) => c.name === name && c.bucket === "pass")) &&
  checks.every((c) => c.bucket !== "fail" && c.bucket !== "cancel" && c.bucket !== "pending");
const short = (s: string) => s.slice(0, 12);
const stopped = (e: unknown): boolean => e instanceof SchedulerStopped;
const failed = (checks: PrSnapshot["checks"]): boolean => checks.some((c) => c.bucket === "fail" || c.bucket === "cancel");
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
  const back = (c: ReviewCarry) => step("await_review", movedHeadReceipt(run.reviewedHead, pr.head, c), undefined, pr.head); // scheduler-review-rebase.ts
  if (!carry.ok || !carry.mainParent || !carry.mainHead || !carry.diffHash) return back(carry);
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
 * still bounces; after the claim only the head-pinned merge API runs (GitHub refuses a moved head, so nothing merges early). */
async function claimAndMerge(run: MergeRun, external: MergeExternal, step: Step, assertActive: () => void, trained = false,
  recheck: Recheck = () => null): Promise<MergeRun> {
  const fresh = await external.inspect(run.prRef);
  const same = samePr(run, fresh);
  if (same && fresh.mergeState === "UNKNOWN") return unknownWait(run, step);
  const bounced = await bounceStep(run, fresh, external, step);
  if (bounced) return bounced;
  if (!same || fresh.mergeState !== "CLEAN" || !green(run, fresh.checks)) return step("unknown", "合并前最后一次核对发现 PR/head/CI 已变");
  if (trained && await external.train?.(run) !== "cleared") return run; // a train voided before the claim: no merge sent, retried next round
  const claimed = await step("merging", `CI 全绿：${fresh.checks.map((c) => c.name).join(", ").slice(0, 300)}`);
  assertActive();
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
  return step("merged", `PR 已合并 ${short(mergeSha)}，待 PM 部署`, mergeSha);
}

/** A changed head returns to review unless it only merged main in; an unobserved merge is never retried. */
export async function driveMerge(run: MergeRun, source: MergeExternal, advance: MergeAdvance,
  assertActive: () => void = () => {}, recheck: Recheck = () => null): Promise<MergeRun> {
  let noChecks = false; // the last read: a wait that expired on "no checks reported" says so
  const step = async (to: MergePhase, receipt?: string, mergeSha?: string, newHead?: string) => {
    assertActive();
    if (to === "unknown" && receipt === UNKNOWN_LIMIT_REASON && noChecks) receipt = NO_CHECKS_LIMIT_REASON;
    run = await advance(run.phase, to, run.rev, receipt, mergeSha, newHead);
    return run;
  };
  const external = watchUnknown(() => run, source, step, (pr) => { noChecks = pr.noChecks === true; });
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
      const bounced = await bounceStep(run, pr, external, step);
      if (bounced) return bounced;
      // Before update-branch: a stale PR GitHub is still computing may be a conflict, which only bounces once it reads DIRTY.
      if (pr.mergeState === "UNKNOWN") return unknownWait(run, step); // GitHub 尚未算出 mergeability，下一轮只读重查
      // GitHub reports CLEAN for a stale branch unless "require up to date" is on, so staleness is asked directly.
      const train = await external.train?.(run); // merge train: wait while it tests, bounce its culprit, skip update-branch once verified
      if (train && train !== "cleared") return train === "wait" ? run : step("resolved", train.bounce);
      if (train !== "cleared" && ((await external.freshness(run.prRef, pr.head)).behindBy > 0 || pr.mergeState === "BEHIND")) {
        const claimed = await step("updating");
        assertActive();
        return await updateOrBounce(claimed, external, step, stopped);
      }
      if (unstableWait(pr) === "failed") return step("unknown", "CI 失败或取消");
      if (pr.mergeState !== "CLEAN" && pr.mergeState !== "UNSTABLE") return step("unknown", `PR mergeState=${pr.mergeState}`);
      const waiting = await step("await_ci", `PR ${short(pr.head)} 可合并，等待 CI`); // a train-cleared green member merges in this same call
      return train === "cleared" && pr.mergeState === "CLEAN" && green(waiting, pr.checks) ? await claimAndMerge(waiting, external, step, assertActive, true, recheck) : waiting;
    }
    if (run.phase === "updating") {
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
      if (train !== "cleared" && pr.mergeState === "BEHIND" && sameHead(run, pr) && pr.state === "OPEN" && !pr.draft && !pr.crossRepository &&
        pr.base === "main" && pr.branch === run.expectedBranch) return failed(pr.checks) ? unsettled ? run : step("unknown", "CI 失败或取消") : await refresh("等 CI 期间 GitHub 报 BEHIND");
      const unstable = unstableWait(pr); // The final pre-merge check below still demands CLEAN, so waiting here never merges early.
      if (unstable && sameHead(run, pr) && pr.state === "OPEN" && !pr.draft && !pr.crossRepository &&
        pr.base === "main" && pr.branch === run.expectedBranch) return unstable === "wait" || unsettled ? run : step("unknown", "CI 失败或取消");
      if (!sameHead(run, pr) || pr.state !== "OPEN" || pr.draft || pr.crossRepository || pr.base !== "main" || pr.branch !== run.expectedBranch || pr.mergeState !== "CLEAN") {
        return step("unknown", "CI 前 PR/head/base/mergeability 变了");
      }
      if (pr.checks.some((c) => c.bucket === "fail" || c.bucket === "cancel")) return step("unknown", "CI 失败或取消");
      if (!green(run, pr.checks)) return run;
      const stale = await external.freshness(run.prRef, pr.head); // GitHub keeps saying CLEAN for a stale branch; a train clearance is re-asked after it
      if (stale.behindBy > 0 && (train !== "cleared" || await external.train?.(run) !== "cleared")) return await refresh(`等 CI 期间 main 前进到 ${short(stale.mainHead)}，落后 ${stale.behindBy} 个提交`);
      return await claimAndMerge(run, external, step, assertActive, train === "cleared", recheck);
    }
    if (run.phase === "merging") {
      const pr = await external.inspect(run.prRef);
      return pr.state === "MERGED" && pr.base === "main" && pr.mergeSha && /^[a-f0-9]{40}$/i.test(pr.mergeSha) && sameHead(run, pr)
        ? step("merged", `重启后核实 PR 已合并 ${short(pr.mergeSha)}，待 PM 部署`, pr.mergeSha)
        : step("unknown", "合并曾发出但未能核实结果，不重复 gh pr merge");
    }
    return run;
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e; // Shutdown or lost ownership leaves the journal for the new controller to reconcile.
    if (["unknown", "merged", "resolved"].includes(run.phase)) throw e;
    return step("unknown", `外部步骤失败：${(e as Error).message.replace(/\s+/g, " ").slice(0, 450)}`);
  }
}
