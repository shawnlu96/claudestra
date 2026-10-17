/**
 * Order-side wiring for the branch context (generality-BRANCH1): the write-order plan used by lend-write-materials.ts, the
 * target a remote fix / reborrow must keep, and the local author start. Resolution rules are in project-branch.ts.
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";
import { recordObserved } from "./recovery-policy.js";
import { branchContextMode, carriedTarget, carryBranchContext, FLOKA_REMOTE, LEGACY_TARGET, parseBranchContext,
  resolveBranchContext, type BranchContext, type BranchContextResult } from "./project-branch.js";

export type { BranchContext, BranchContextResult } from "./project-branch.js";

/** The card field a dispatcher fills (BRANCH2 / PROJDECL wiring); everything downstream only reads and re-checks it. */
const BRANCH_CONTEXT_FIELD = "branchContext";

export interface WriteBranchPlan {
  /** Ref whose remote head becomes the order's start. */
  startRef: string;
  settle(fp: string, head: string): { fp: string; base: string; baseSha: string; report: null; branchContext?: BranchContext };
}
interface Probe { branchContext?(task: LedgerTask, q: { repo: string; base: string }): Promise<BranchContextResult> }

const stop = (r: Extract<BranchContextResult, { ok: false }>) => new LedgerError("conflict", `分支上下文停人工（${r.code}）：${r.reason}`);

/** Context carried on the card: undefined = none, null = present but malformed (a stop, never a fallback). */
const cardBranchContext = (task: Pick<LedgerTask, "extra">): BranchContext | null | undefined =>
  task.extra?.[BRANCH_CONTEXT_FIELD] === undefined ? undefined : parseBranchContext(task.extra[BRANCH_CONTEXT_FIELD]);

async function contextFor(task: LedgerTask, q: { repo: string; base: string }, probe: Probe): Promise<BranchContextResult> {
  const carried = cardBranchContext(task);
  if (carried === null) return { ok: false, code: "CONTEXT_MISSING", reason: "卡上的分支上下文不合法" };
  if (carried && carried.remote !== q.repo) return { ok: false, code: "REMOTE_MISMATCH", reason: `卡上下文仓库 ${carried.remote} 与订单仓库 ${q.repo} 不符` };
  const probed = probe.branchContext ? await probe.branchContext(task, q) : null;
  if (probed && !probed.ok) return probed;
  if (probed && carried) return carryBranchContext(carried, probed.context);
  if (probed) return probed;
  if (carried) return { ok: true, context: carried };
  // Legacy completion: only the Floka repository has a configured target; anything else stays ambiguous and stops.
  if (q.repo === FLOKA_REMOTE) return resolveBranchContext({ remote: q.repo, defaultBranch: null, configTarget: LEGACY_TARGET, workStartRef: q.base });
  return { ok: false, code: "CONTEXT_MISSING", reason: `${q.repo} 没有分支上下文，也没有目标声明；不按 main 猜` };
}

function observe(db: Database, task: LedgerTask, q: { base: string }, found: BranchContextResult): void {
  const candidate = found.ok ? { target: found.context.targetBranch, start: found.context.workStartRef } : { code: found.code };
  if (found.ok && found.context.targetBranch === LEGACY_TARGET && found.context.workStartRef === q.base) return;
  try {
    recordObserved(db, { project: task.project, mechanism: "projectBranchContext", target: task.id, actionKey: `write-target:${task.specRev}:${task.round}`,
      action: "按分支上下文定写单的合并目标与起点", data: { previous: { target: LEGACY_TARGET, start: q.base }, candidate } }, Date.now());
  } catch { /* Observation is a record only; failing to write it never changes the legacy action. */ }
}

/** Write order plan. observe keeps the legacy plan exactly and records any difference; on carries the context; off is legacy. */
export async function writeBranchPlan(db: Database, task: LedgerTask, q: { repo: string; base: string }, probe: Probe): Promise<WriteBranchPlan> {
  const mode = branchContextMode(task.project);
  const legacy: WriteBranchPlan = { startRef: q.base, settle: (fp, head) => ({ fp, base: LEGACY_TARGET, baseSha: head, report: null }) };
  if (mode === "off") {
    // Off stops propagation, but a card already recorded for another target is not re-defaulted to main.
    const carried = cardBranchContext(task);
    if (carried === null || (carried && carried.targetBranch !== LEGACY_TARGET)) {
      throw stop({ ok: false, code: "CONTEXT_CHANGED", reason: "恢复键 off，卡上记录的合并目标不是 main，不改回 main" });
    }
    return legacy;
  }
  const found = await contextFor(task, q, probe);
  if (mode === "observe") { observe(db, task, q, found); return legacy; }
  if (!found.ok) throw stop(found);
  const c = found.context;
  return { startRef: c.workStartRef, settle: (fp, head) => {
    if (c.workStartSha && c.workStartSha !== head) throw stop({ ok: false, code: "BASIS_STALE", reason: `起点 ${c.workStartRef} 的远端 head 与上下文记录不符` });
    return { fp, base: c.targetBranch, baseSha: head, report: null, branchContext: { ...c, workStartSha: head } };
  } };
}

/** The PR base a remote fix order keeps: the card's latest write/fix order base under on, legacy main otherwise. */
export function fixOrderBase(db: Database, task: Pick<LedgerTask, "id" | "project" | "extra">): string {
  const row = db.query("SELECT base FROM lend_orders WHERE taskId = ? AND base IS NOT NULL ORDER BY createdAt DESC, rowid DESC LIMIT 1")
    .get(task.id) as { base: string } | null;
  const base = carriedTarget(task.project, row?.base ?? cardBranchContext(task)?.targetBranch);
  if (!base) throw new LedgerError("conflict", "分支上下文停人工（CONTEXT_MISSING）：找不到本卡已记录的合并目标，不按 main 猜");
  return base;
}

/** Base for a fix order offered through writeMaterials: the caller's base unless on, where the card's recorded target wins. */
export const fixWriteBase = (db: Database, task: LedgerTask, base: string): string =>
  branchContextMode(task.project) === "on" ? fixOrderBase(db, task) : base;

/**
 * Local author start ref. on: the carried context's start (SHA when fixed); a malformed context is a reason string (stop).
 * observe / off: the legacy origin/main or local main, unchanged.
 */
export function localAuthorStart(task: Pick<LedgerTask, "project" | "extra" | "headSHA">, local: boolean): { base: string } | string {
  const legacy = { base: task.headSHA ?? (local ? LEGACY_TARGET : `origin/${LEGACY_TARGET}`) };
  if (branchContextMode(task.project) !== "on") return legacy;
  const c = cardBranchContext(task);
  if (c === null) return "卡上的分支上下文不合法";
  if (!c || task.headSHA) return legacy;
  return { base: c.workStartSha ?? (local ? c.workStartRef : `origin/${c.workStartRef}`) };
}
