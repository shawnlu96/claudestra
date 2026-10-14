/**
 * After a write lease is reclaimed (PM `ledger lend-reclaim`, or a scheduler fix_strategy_reclaim) a same-family fresh-session fix
 * has no held lease to send the new order back to; without this the intent throws and stays pending for good.
 * Switch reclaimLocalFix (off / observe / on, absent = observe): on builds the fix author on this machine with the material's
 * family, observe records the would-be build once, off is the old refusal. Only a reclaim after the current head's delivery counts,
 * so a card that was never reclaimed and has no held lease still refuses in every mode. tests/recovery-reclaim-local-fix.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { mustTask } from "./ledger-checks.js";
import type { AuthorFamily, SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { listEvents } from "./ledger-store.js";
import { heldLease } from "./ledger-lend-lease.js";
import type { SwapGate } from "./fix-strategy-guard.js";
import { recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";

const RECLAIM_LOCAL_FIX_KEY = "reclaimLocalFix" as const;

const policies = new WeakMap<Database, RecoveryPolicyPort>();
/** Same wiring pattern as setLocalSwapPorts: tests inject a policy per ledger, the service reads recovery-policy.json. */
export const setReclaimLocalFixPolicy = (db: Database, p: RecoveryPolicyPort): void => void policies.set(db, p);
const modeOf = (db: Database, project: string): RecoveryMode => (policies.get(db) ?? recoveryPolicy)(project, RECLAIM_LOCAL_FIX_KEY).mode;

const isLendReclaim = (e: LedgerEvent) => e.kind === "note" && (e.data.lend as { op?: unknown } | undefined)?.op === "reclaim";
const isSchedulerReclaim = (e: LedgerEvent, t: LedgerTask) => e.kind === "scheduler" && e.data.op === "fix_strategy_reclaim" &&
  e.data.round === t.round && e.data.specRev === t.specRev && e.data.head === t.headSHA;

/** The reclaim that ended the lease which wrote the current head: any reclaim recorded after that head's delivery; null = none. */
function reclaimOfCurrentHead(db: Database, task: LedgerTask): LedgerEvent | null {
  if (!task.headSHA) return null;
  const events = listEvents(db, { project: task.project, target: task.id });
  const delivered = events.findLast((e) => e.kind === "deliver" && e.data.headSHA === task.headSHA)?.seq;
  if (delivered === undefined) return null;
  return events.findLast((e) => e.seq > delivered && (isLendReclaim(e) || isSchedulerReclaim(e, task))) ?? null;
}

export type ReclaimLocalFix = { act: true; reclaim: LedgerEvent } | { act: false; why: string };

/** on = act; observe records one note per card / spec / round / reclaim and refuses as before; off and no reclaim refuse as before. */
export function reclaimLocalFixGate(db: Database, ctx: WriteCtx, intent: SchedulerIntent, task: LedgerTask, family: AuthorFamily): ReclaimLocalFix {
  const reclaim = reclaimOfCurrentHead(db, task);
  if (!reclaim) return { act: false, why: "" };
  const mode = modeOf(db, task.project);
  if (mode === "on") return { act: true, reclaim };
  if (mode === "observe") {
    recordObserved(db, { project: task.project, mechanism: RECLAIM_LOCAL_FIX_KEY, target: task.id, actionKey: `s${task.specRev}:r${task.round}:e${reclaim.seq}`,
      action: `在本机建 ${family} 修复作者接着修（第 ${task.round} 轮，收回事件 #${reclaim.seq}）`,
      data: { intentId: intent.id, specRev: task.specRev, round: task.round, head: task.headSHA, reclaimSeq: reclaim.seq, family } }, ctx.now ?? Date.now());
  }
  return { act: false, why: `；已收回（事件 #${reclaim.seq}），reclaimLocalFix=${mode}` };
}

/**
 * The gate the local build re-reads at its create and bind edges (after the tree / Codex slot awaits): the switch is still on, no lease
 * was taken again, and the same reclaim is still the current head's. Without it a switch to observe / off mid-build would still bind.
 */
export function reclaimLocalFixEdge(db: Database, taskId: string, reclaimSeq: number): SwapGate {
  return () => {
    const task = mustTask(db, taskId), mode = modeOf(db, task.project);
    const why = mode !== "on" ? `reclaimLocalFix 已切到 ${mode}，停在下一副作用前`
      : heldLease(db, task) ? "写租约又被持有，不在本机另建作者"
      : reclaimOfCurrentHead(db, task)?.seq !== reclaimSeq ? "收回事件已不是当前 head 的，旧接修计划失效" : null;
    return why ? { halted: "drift", reason: why } : null;
  };
}
