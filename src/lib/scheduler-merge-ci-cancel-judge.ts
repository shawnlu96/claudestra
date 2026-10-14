/**
 * The merge gate's one red / cancelled judgment (merge-arch-CICANCEL1) and the receipts of the cancel path. Pure: no ledger, no gh,
 * so the conflict, CIF1, carried and driver modules all import it without a cycle. A cancel is never green (`redCheck`); a required
 * cancel with no failed check anywhere is "CI 被取消" (`cancelOnly`), which ciCancelStep handles instead of ci_fail when the switch
 * is on. Any failed check keeps the ci_fail path. tests/scheduler-merge-ci-cancel.test.ts.
 */
import type { PrSnapshot } from "./scheduler-merge-driver.js";
import type { MergeRun } from "./scheduler-merge.js";

type Check = PrSnapshot["checks"][number];
/** Failed or cancelled: what bounceStep, ciRed and the driver's failed() count as red. Neither is ever a green check. */
export const redCheck = (c: Pick<Check, "bucket">): boolean => c.bucket === "fail" || c.bucket === "cancel";

/** A required check was cancelled and no check (required or not) failed: the run was cut off, nothing in it was judged red. */
export function cancelOnly(run: Pick<MergeRun, "requiredChecks">, checks: PrSnapshot["checks"]): boolean {
  const names = run.requiredChecks.split(",");
  return checks.some((c) => names.includes(c.name) && c.bucket === "cancel") && !checks.some((c) => c.bucket === "fail");
}

/** Appended to CIF1's claim (cases []): the ledger then writes the cancel rerun event and never turns a refusal into a fix bounce. */
const CANCEL_MARK = "，CI 被取消";
const BASE_END = "超时用例 []";
export const cancelClaim = (cif1Claim: string): string => `${cif1Claim}${CANCEL_MARK}`;
/** The claim event's wording (scheduler-merge-ci-rerun.ts ciRerunClaim). */
export const CANCEL_RERUN_TEXT = "CI 被取消，重跑一次";
/** CIF1's claim inside a cancel claim; null for any other receipt (a CIF1 / CIF8 claim stays theirs). */
export function cancelClaimBase(receipt: string): string | null {
  if (!receipt.endsWith(CANCEL_MARK)) return null;
  const base = receipt.slice(0, -CANCEL_MARK.length);
  return base.endsWith(BASE_END) ? base : null;
}

export type CancelPlan = "rerun" | "manual";
/** What the driver read: the PR head (= reviewed head), the one run behind the cancelled checks, and that run's attempt. */
export interface CancelFacts { prHead: string; link: string; attempt: number }
const FACTS = "PR head ([a-f0-9]{40})，run (https://github\\.com/[\\w.-]+/[\\w.-]+/actions/runs/\\d+)，第 (\\d+) 次";
const facts = (f: CancelFacts): string => `PR head ${f.prHead}，run ${f.link}，第 ${f.attempt} 次`;
const parseFacts = (m: RegExpExecArray, at: number): CancelFacts | null => {
  const attempt = Number(m[at + 2]);
  return Number.isSafeInteger(attempt) && attempt >= 1 ? { prHead: m[at]!, link: m[at + 1]!, attempt } : null;
};

/** The run ends unsent and the card goes to the PM (scheduler-merge-ci-cancel.ts toPm); `why` is the reason it gives. */
export const CANCEL_TWICE = "CI 连续被取消";
const MANUAL_LEAD = "CI 被取消，退人工";
export const cancelManualReceipt = (f: CancelFacts, why: string): string => `${MANUAL_LEAD}（${why}）：${facts(f)}`;
const MANUAL = new RegExp(`^${MANUAL_LEAD}（([^（）]{1,120})）：${FACTS}$`);
export function parseCancelManual(receipt: string): (CancelFacts & { why: string }) | null {
  const m = MANUAL.exec(receipt);
  const f = m && parseFacts(m, 2);
  return f ? { ...f, why: m![1]! } : null;
}

/** observe: the driver tells the ledger what on would do, the ledger records it; the run itself goes on as with off. */
const OBSERVE_LEAD = "CI 被取消（观察）";
const PLAN_TEXT: Record<CancelPlan, string> = { rerun: "重跑一次", manual: "退人工" };
export const cancelObserveReceipt = (f: CancelFacts, plan: CancelPlan): string => `${OBSERVE_LEAD}，on 时会${PLAN_TEXT[plan]}：${facts(f)}`;
const OBSERVE = new RegExp(`^${OBSERVE_LEAD.replace(/[()（）]/g, "\\$&")}，on 时会(重跑一次|退人工)：${FACTS}$`);
export function parseCancelObserve(receipt: string): (CancelFacts & { plan: CancelPlan }) | null {
  const m = OBSERVE.exec(receipt);
  const f = m && parseFacts(m, 2);
  return f ? { ...f, plan: m![1] === PLAN_TEXT.rerun ? "rerun" : "manual" } : null;
}
