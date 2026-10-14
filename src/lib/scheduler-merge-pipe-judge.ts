/**
 * merge-arch-MRGPIPE1 · the pure judgments of the merge-slot pipe (scheduler-merge-pipe.ts runs them): whether a project may
 * lend its slot this pass, whether the holder still waits on its own CI, whether a borrower can merge right now, and whether
 * two PRs' changed files are disjoint. Every unknown is a refusal: an unread file list overlaps, a missing fact refuses.
 */
import type { RecoveryMode } from "./recovery-policy.js";
import { ciRed } from "./scheduler-merge-ci-carried.js";
import { green, type PrSnapshot } from "./scheduler-merge-driver.js";
import type { MergeRun } from "./scheduler-merge.js";
import { SLOT_YIELD } from "./scheduler-merge-train-hold.js";

export const MERGE_PIPE_KEY = "mergePipe" as const;
/** Borrower candidates inspected per project and pass (one PR read each, file lists cached). */
export const PIPE_CANDIDATES = 3;
/** Lends per holder run: each one re-reads the holder's CI first, so the cap only bounds a CI that never settles. */
export const PIPE_LENDS_MAX = 5;
export const PIPE_TAG = "MRGPIPE";
const LEND_PREFIX = `${SLOT_YIELD}${PIPE_TAG} 借给 `;

/** The yield receipt: starts with SLOT_YIELD, so the ledger turns the slot through turnMergeSlot (rev CAS + drift check). */
export const pipeReceipt = (borrower: string): string => `${LEND_PREFIX}${borrower}（已绿、改动不相交）先合`;
/** The borrower a pipe yield names; null for any other receipt (a train's yield, a reclaim, none). */
export const pipeBorrower = (receipt: string | null | undefined): string | null =>
  receipt?.startsWith(LEND_PREFIX) ? /^[^\s（]+/.exec(receipt.slice(LEND_PREFIX.length))?.[0] ?? null : null;

/** Disjoint only when both lists were read and share no path (renames list their old path too). */
export function filesDisjoint(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (!a || !b) return false;
  const seen = new Set(a);
  return !b.some((f) => seen.has(f));
}

export interface PipeProjectFacts {
  mode: RecoveryMode;
  /** mergeDirect is on (observe / off / unreadable = false). */
  direct: boolean;
  autoDispatch: boolean;
  /** A train state store exists (none in a test process) and its file was read. */
  store: boolean;
  trainHolds: boolean;
  /** blocksTrain(manualTurn(...)): a manual merge request is due or merging. */
  manualBlocks: boolean;
  frozen: boolean;
  mainCiPaused: boolean;
  ciCoverageOn: boolean;
}

/** Why this project lends nothing this pass, or null. */
export function projectRefusal(f: PipeProjectFacts): string | null {
  if (f.mode === "off") return "mergePipe off";
  if (!f.direct) return "mergeDirect 没开";
  if (!f.autoDispatch) return "autoDispatch 没开，没人计划借槽卡";
  if (!f.store) return "没有列车状态存储";
  if (f.trainHolds) return "列车正占路";
  if (f.manualBlocks) return "人工合并队首到期或正在合并";
  if (f.frozen) return "合并队列冻结";
  if (f.mainCiPaused) return "主线 CI 暂停";
  if (f.ciCoverageOn) return "ciCoverageGate on：借出会让占槽卡的 CI 证明失效";
  return null;
}

export interface PipeHolderFacts {
  manual: boolean;
  intentStatus: string | null;
  phase: string | null;
  drift: string | null;
  lends: number;
  /** Taken back or claimed in this pass: this pass's extra mergeTick drives it first. */
  late: boolean;
  skip: boolean;
}

/** Why the slot holder lends nothing, before any PR read; null = read its PR. */
export function holderRefusal(h: PipeHolderFacts): string | null {
  if (h.manual) return "占槽卡是人工合并";
  if (h.intentStatus !== "submitted" || h.phase !== "await_ci") return `占槽卡不在等 CI（${h.intentStatus ?? "-"}/${h.phase ?? "-"}）`;
  if (h.drift) return `占槽卡已漂移：${h.drift}`;
  if (h.lends >= PIPE_LENDS_MAX) return `本运行已借出 ${h.lends} 次`;
  if (h.late) return "占槽卡本轮刚拿回槽";
  if (h.skip) return "占槽卡本轮跳过";
  return null;
}

/**
 * The holder's PR as just read: null = it will wait again next pass (some required check has no verdict yet, red shards
 * before the gate included), so lending costs it nothing; else why not (green or failed: it merges or bounces next).
 */
export function holderWaits(run: Pick<MergeRun, "reviewedHead" | "requiredChecks">, pr: PrSnapshot): string | null {
  if (pr.state !== "OPEN") return `占槽卡 PR ${pr.state}`;
  if (pr.head.toLowerCase() !== run.reviewedHead.toLowerCase()) return "占槽卡 head 已变";
  if (pr.mergeState === "DIRTY") return "占槽卡 DIRTY";
  if (ciRed(run, pr.checks) === "required") return "占槽卡必需检查已失败";
  const open = run.requiredChecks.split(",").some((n) => !pr.checks.some((c) => c.name === n && c.bucket !== "pending"));
  return open ? null : "占槽卡必需检查都已出结论";
}

/** A borrower merges in the pass it is planned only from here: its own open PR at the card head, CLEAN / BEHIND, all green. */
export function borrowerReady(task: { headSHA: string | null; branch: string | null }, requiredChecks: string, pr: PrSnapshot): string | null {
  if (pr.state !== "OPEN" || pr.draft) return `PR ${pr.state}${pr.draft ? " draft" : ""}`;
  if (!task.headSHA || pr.head.toLowerCase() !== task.headSHA.toLowerCase()) return "PR head 与卡不同";
  if (pr.crossRepository || pr.base !== "main" || pr.branch !== task.branch) return "PR 分支 / base 不对";
  if (pr.mergeState !== "CLEAN" && pr.mergeState !== "BEHIND") return `mergeState=${pr.mergeState}`;
  return green({ requiredChecks }, pr.checks) ? null : "CI 未全绿";
}
