/**
 * Required CI that was only cancelled (merge-arch-CICANCEL1): GitHub's PR concurrency group cancels a whole run whenever another run
 * of the PR starts (a re-run of an older head included), so "every red check is a cancel" says nothing about the reviewed code.
 * Switch `ciCancelRerun`: off = the old ci_fail path; observe = the same, plus one note saying what on would do; on = the cancelled
 * run is re-run once through CIF1's claim (same once-per-head budget, same send journal), and a run that was already re-run and is
 * cancelled again goes to the PM, never to fix: through the driver's fallback-manual hook (the foreign-repo one) with the reason,
 * else the run ends unsent and the planner's merge_retry_requires_pm hands the card over. Any failed check is ci_fail in every mode (cancelOnly), and a run
 * whose head is not the reviewed head is never re-run: the gate waits and reads the checks again. tests/scheduler-merge-ci-cancel*.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { LedgerError } from "./ledger-store.js";
import { recordObserved, recoveryPolicy, type RecoveryMode } from "./recovery-policy.js";
import { MERGE_NOT_SENT } from "./manual-merge-queue-facts.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { rethrowCiLogStop } from "./scheduler-merge-ci-log-read.js";
import { ciRerunGhOf, CI_RUN_LINK, fitRerunReceipt } from "./scheduler-merge-ci-rerun.js";
import { RECEIPT_MAX } from "./scheduler-merge-ci-receipt.js";
import { CANCEL_TWICE, cancelClaim, cancelClaimBase, cancelManualReceipt, cancelObserveReceipt, cancelOnly, parseCancelManual,
  parseCancelObserve, type CancelFacts } from "./scheduler-merge-ci-cancel-judge.js";
import type { MergeBounce } from "./scheduler-merge-conflict.js";
import type { ForeignEscalate, MergeExternal, PrSnapshot } from "./scheduler-merge-driver.js";
import type { MergePhase, MergeRun } from "./scheduler-merge.js";

let source: ((project: string) => RecoveryMode) | null = null;
/** Tests only: answer the mode without a recovery-policy.json; null restores the file. */
export function setCiCancelModeSource(fn: ((project: string) => RecoveryMode) | null): void { source = fn; }
export const ciCancelMode = (project: string): RecoveryMode => source ? source(project) : recoveryPolicy(project, "ciCancelRerun").mode;

type Step = (to: MergePhase, receipt?: string) => Promise<MergeRun>;
type Hosted = MergeExternal & { cancelHandoff?: ForeignEscalate };
/** driveMerge's fallback-manual hook, carried on the external so bounceStep reaches it; absent = the ledger-only handover. */
export const withCancelHandoff = (external: MergeExternal, handoff?: ForeignEscalate): MergeExternal =>
  handoff ? { ...external, cancelHandoff: handoff } as Hosted : external;
const sameSha = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const oneLine = (e: unknown) => (e as Error).message.trim().split("\n")[0]?.slice(0, 300) ?? "";

/** The one workflow run every cancelled required check links to, or null (no link, several runs): the old path then decides. */
function oneRun(checks: MergeBounce["checks"]): { repo: string; runId: string; link: string } | null {
  const runs = checks.map((c) => CI_RUN_LINK.exec(c.link));
  if (!runs.length || runs.some((m) => !m) || new Set(runs.map((m) => `${m![1]}/${m![2]}`)).size !== 1) return null;
  const [repo, runId] = [runs[0]![1]!, runs[0]![2]!];
  return { repo, runId, link: `https://github.com/${repo}/actions/runs/${runId}` };
}

/**
 * Driver side, in bounceStep before CIF1 / CIF2, for a ci_fail on the untouched reviewed head. null = not this path (a failed check,
 * off, no gh, an unreadable run, a run that did not end cancelled): the caller goes on exactly as before. Otherwise the run as stepped:
 * waiting (run still going, or not on the reviewed head), the claimed rerun, or the run ended for the PM.
 */
export async function ciCancelStep(run: MergeRun, pr: PrSnapshot, external: MergeExternal, step: Step, checks: MergeBounce["checks"]): Promise<MergeRun | null> {
  if (!cancelOnly(run, pr.checks)) return null;
  const mode = ciCancelMode(run.project);
  const gh = mode === "off" ? null : ciRerunGhOf(external);
  const target = gh && oneRun(checks);
  if (!gh || !target) return null;
  let read: Awaited<ReturnType<typeof gh.runAttempt>>;
  try {
    read = await gh.runAttempt(target.repo, target.runId);
  } catch (e) {
    rethrowCiLogStop(e);
    console.error(`⚠️ [merge] ${run.taskId} CI 被取消，读 run 失败，按原路判：${oneLine(e)}`);
    return null;
  }
  const on = mode === "on";
  // A check link may point at another head's run (an older head re-run by hand): never re-run that one, read again next round.
  if (!sameSha(read.headSha, run.reviewedHead) || read.status !== "completed") return on ? run : null;
  if (read.conclusion !== "cancelled") return null;
  const facts: CancelFacts = { prHead: pr.head, link: target.link, attempt: read.attempt };
  const plan = read.attempt > 1 ? "manual" : "rerun";
  if (!on) {
    await step("resolved", cancelObserveReceipt(facts, plan)); // the ledger records it; phase and rev stay as they are
    return null;
  }
  if (plan === "manual") return toPm(run, external, step, facts, CANCEL_TWICE);
  const base = fitRerunReceipt(pr.head, { link: target.link, checks: checks.map((c) => c.name), cases: [] });
  const receipt = base && cancelClaim(base);
  if (!receipt || receipt.length > RECEIPT_MAX) return null; // evidence too long for a claim: the old path decides
  const rev = run.rev;
  const claimed = await step("resolved", receipt);
  if (claimed.phase === "resolved" || claimed.rev === rev) return claimed; // ended for the PM, or claimed earlier and still waiting
  try {
    await gh.rerunFailed(target.repo, target.runId);
    return claimed;
  } catch (e) {
    // No hook here: a send the main CI gate refused leaves its held run, which the guarded step returns for this receipt.
    console.error(`⚠️ [merge] ${run.taskId} CI 被取消，gh run rerun 失败，退人工：${oneLine(e)}`);
    return step("resolved", cancelManualReceipt(facts, "重跑没有发出"));
  }
}

/** The card goes to the PM with `why` first, then the unsent run ends (manualCancel); a refused hand-over ends it in the ledger. */
async function toPm(run: MergeRun, external: MergeExternal, step: Step, facts: CancelFacts, why: string): Promise<MergeRun> {
  const handoff = (external as Hosted).cancelHandoff;
  const reason = `${why}：${facts.link}（第 ${facts.attempt} 次）`;
  if (handoff) {
    try {
      await handoff(run, `pm_takeover: ${reason}；解除：PM 核对是谁取消了本 head 的 CI，重跑绿后交回合并队列`); // manual-reason.ts code format
      return await step("unknown", `${MERGE_NOT_SENT}：${reason}`);
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      console.error(`⚠️ [merge] ${run.taskId} ${why}，退人工没写成，改由台账结束本次合并：${oneLine(e)}`);
    }
  }
  return step("resolved", cancelManualReceipt(facts, why));
}

type CancelRun = (db: Database, ctx: WriteCtx, row: MergeRun, receipt: string, why: string) => void;

/**
 * Ledger side, wrapping closeMergeRun's claim chain (`next` = CIF2 → CIF1). null = handled here or claimed there. An observe receipt
 * writes its one note; a cancel claim under a mode other than on changes nothing (the driver re-reads the mode next round); a manual
 * receipt (the driver's, or CIF1's answer to a cancel claim it cannot honor) ends the run unsent: no bounce, no freeze, and the
 * planner then hands the card to the PM (merge_retry_requires_pm).
 */
export function ciCancelGate(db: Database, ctx: WriteCtx, row: MergeRun, receipt: string, drift: string | null,
  next: (receipt: string) => string | null, cancelRun: CancelRun): string | null {
  const observed = parseCancelObserve(receipt);
  if (observed) {
    // observe must change nothing: a stale or drifted run records no note here and meets the old path's own checks instead
    if (!drift && sameSha(observed.prHead, row.reviewedHead) && ciCancelMode(row.project) === "observe") {
      recordObserved(db, { project: row.project, target: row.taskId, mechanism: "ciCancelRerun",
        actionKey: `${observed.prHead.toLowerCase()}:${observed.link.split("/").pop()}:${observed.attempt}`,
        action: observed.plan === "rerun" ? `CI 被取消，重跑一次（第 ${observed.attempt} 次）` : `${CANCEL_TWICE}，退人工（第 ${observed.attempt} 次）`,
        data: { intentId: row.intentId, prHead: observed.prHead, run: observed.link, attempt: observed.attempt, plan: observed.plan } }, ctx.now ?? Date.now());
    }
    return null;
  }
  if (cancelClaimBase(receipt) !== null && ciCancelMode(row.project) !== "on") return null;
  const own = next(receipt);
  const manual = own === null ? null : parseCancelManual(own);
  if (!manual) return own;
  check(row, manual.prHead, drift);
  if (ciCancelMode(row.project) !== "on") return null;
  cancelRun(db, ctx, row, own!, `${manual.why}：${manual.link}（第 ${manual.attempt} 次）`);
  return null;
}

function check(row: MergeRun, prHead: string, drift: string | null): void {
  if (drift) throw new LedgerError("conflict", `合并运行已失效：${drift}`);
  if (!sameSha(prHead, row.reviewedHead)) throw new LedgerError("invalid", "CI 被取消回执的 head 与本次合并不符");
}
