/**
 * merge-arch-CARRYCNT1 · ledger side of the count carry, in the merge step's own transaction (scheduler-merge.ts carryReview calls
 * countCarryReview first). A receipt not starting with COUNT_CARRY_LEAD is null (CARRY2 as before); one that does is written only
 * when all hold, else a LedgerError and not one row: the scheduler identity; a strict receipt naming (row.reviewedHead, newHead);
 * effCountCarry read now is on; the run is `updating` and the claim that put it there is the scheduler's own EFFAUTO1 claim for
 * exactly (H0, H1) (never git's author field); the task in merge at H0, no UI card, no manual_merge run; the formal source PASS
 * (reviewProof on carrySourceTask, injected: no import of scheduler-merge.ts) holds; no count carry since that review (one per
 * source review: bounded, never chasing main). The review_carry it writes is its last row, so carriedHead finds merge_phase at seq+1.
 * tests/review-count-carry-ledger.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { mustTask } from "./ledger-checks.js";
import { getIntent, getWorkflow } from "./ledger-scheduler.js";
import { LedgerError, listEvents } from "./ledger-store.js";
import { insertEvent } from "./ledger-tx.js";
import { MANUAL_MERGE_NODE } from "./manual-merge-queue-facts.js";
import { recoveryPolicy, type RecoveryMode } from "./recovery-policy.js";
import { carrySourceTask } from "./review-main-carry-auto-source.js";
import type { ReviewProof } from "./review-main-carry-manual-auto.js";
import type { MergeRun } from "./scheduler-merge.js";
import type { UiCarryPlan } from "./scheduler-ui-carry.js";
import { SKIP_EFFECTS_INVENTORY } from "./skip-effects-auto-scope.js";

export const EFF_COUNT_CARRY_KEY = "effCountCarry" as const;
const COUNT_CARRY_LEAD = "计数沿用：";
export interface CountCarryEvidence { oldHead: string; newHead: string; blobFrom: string; blobTo: string }
export const countCarryReceipt = (e: CountCarryEvidence): string => `${COUNT_CARRY_LEAD}原 head ${e.oldHead} → 新 head ${e.newHead}，` +
  `只多一个效果点计数提交，清单 blob ${e.blobFrom} → ${e.blobTo}，等待 CI`;
const RECEIPT = /^计数沿用：原 head ([a-f0-9]{40}) → 新 head ([a-f0-9]{40})，只多一个效果点计数提交，清单 blob ([a-f0-9]{40}) → ([a-f0-9]{40})，等待 CI$/;
function parseCountCarryReceipt(receipt: string): CountCarryEvidence | null {
  const m = RECEIPT.exec(receipt);
  return m ? { oldHead: m[1]!, newHead: m[2]!, blobFrom: m[3]!, blobTo: m[4]! } : null;
}
/** EFFAUTO1's `updating` claim receipt (effect-count-refresh.ts pushAndClaim), pinned by tests/review-count-carry.test.ts on its real path. */
const CLAIM = /^效果点计数自动刷新（CI 只红在效果点计数）：CI head ([a-f0-9]{40}) → 计数提交 ([a-f0-9]{40})（/;

/** Read every time, never throws: an unreadable policy is off. */
export function countCarryMode(project: string): RecoveryMode {
  try {
    const p = recoveryPolicy(project, EFF_COUNT_CARRY_KEY);
    return p.source === "error" ? "off" : p.mode;
  } catch { return "off"; } // an unreadable policy file stops the carry; the re-review it falls back to is the old behaviour
}
let ledgerMode: (project: string) => RecoveryMode = countCarryMode;
/** Tests: the mode the transaction reads, until disposed. */
export function useCountCarryLedgerMode(f: (project: string) => RecoveryMode): Disposable {
  const before = ledgerMode;
  ledgerMode = f;
  return { [Symbol.dispose]: () => { ledgerMode = before; } };
}

const refuse = (why: string): never => { throw new LedgerError("conflict", `计数沿用不成立：${why}`); };

/** The seq of this run's EFFAUTO1 claim for exactly (H0, H1): the last merge_phase into `updating` from another phase, by the scheduler. */
function claimSeq(db: Database, row: MergeRun, oldHead: string, newHead: string): number {
  const claim = listEvents(db, { project: row.project, target: row.taskId }).findLast((e) => e.kind === "scheduler" && e.data.op === "merge_phase" &&
    e.data.intentId === row.intentId && e.data.to === "updating" && e.data.from !== "updating");
  if (!claim || claim.actor !== "scheduler") return refuse("进 updating 的不是调度服务自己写的认领");
  const m = CLAIM.exec(String(claim.data.receipt ?? ""));
  if (!m) return refuse("进 updating 的认领不是效果点计数刷新");
  if (m[1] !== oldHead || m[2] !== newHead) return refuse("认领里的 CI head / 计数提交与回执对不上");
  return claim.seq;
}

/** null = not a count receipt (the caller's CARRY2 path); else the review_carry seq, or a throw with nothing written. */
export function countCarryReview(db: Database, ctx: WriteCtx, row: MergeRun, newHead: string, receipt: string, now: number,
  reviewProof: ReviewProof): { seq: number; ui: UiCarryPlan } | null {
  if (!receipt.startsWith(COUNT_CARRY_LEAD)) return null;
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "计数沿用只许调度服务身份写");
  const ev = parseCountCarryReceipt(receipt);
  if (!ev || ev.oldHead !== row.reviewedHead || ev.newHead !== newHead) throw new LedgerError("invalid", "计数沿用回执缺证据或 head 对不上");
  if (ledgerMode(row.project) !== "on") refuse("写入时 effCountCarry 不是 on");
  if (row.phase !== "updating") refuse(`合并运行在 ${row.phase}，计数沿用只在 updating`);
  const claim = claimSeq(db, row, ev.oldHead, ev.newHead);
  const task = mustTask(db, row.taskId), workflow = getWorkflow(db, row.taskId), intent = getIntent(db, row.intentId);
  if (task.stage !== "merge" || task.headSHA !== ev.oldHead) refuse("任务阶段或旧 head 已变");
  if (!workflow || workflow.template === "ui") refuse("UI 卡（或没有流程记录）不沿用计数提交");
  if (!intent || intent.taskId !== task.id || intent.node === MANUAL_MERGE_NODE) refuse("人工合并（或找不到本 run 的合并意图）不沿用计数提交");
  let sourceReviewSeq: number;
  try { sourceReviewSeq = reviewProof(db, carrySourceTask(db, task), workflow!).eventSeq; }
  catch (e) { return refuse(`正式来源审查门不成立：${(e as Error).message}`); }
  const again = listEvents(db, { project: row.project, target: row.taskId }).some((e) => e.seq > sourceReviewSeq && e.kind === "scheduler" &&
    e.data.op === "review_carry" && e.data.carryKind === "count");
  if (again) refuse(`来源审查 #${sourceReviewSeq} 之后已沿用过一次计数提交`);
  db.prepare("UPDATE tasks SET headSHA=?, rev=rev+1, updatedAt=? WHERE id=?").run(newHead, now, task.id);
  db.prepare("UPDATE scheduler_merges SET reviewedHead=? WHERE intentId=?").run(newHead, row.intentId);
  const seq = insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${row.intentId}:carry:${row.rev}` }, {
    project: row.project, target: row.taskId, kind: "scheduler", text: `计数沿用审查到新 head ${newHead.slice(0, 12)}`,
    data: { op: "review_carry", carryKind: "count", intentId: row.intentId, from: ev.oldHead, to: newHead, round: task.round, specRev: task.specRev,
      sourceReviewSeq, claimSeq: claim, inventory: SKIP_EFFECTS_INVENTORY, blobFrom: ev.blobFrom, blobTo: ev.blobTo },
  }, true).seq;
  return { seq, ui: { note: null, commit: () => {} } };
}
