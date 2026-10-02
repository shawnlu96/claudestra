/**
 * Automatic fix reassignment, the tick's half. Every pass it (1) retries closing the old PR of a delivered relay until that is
 * recorded, and (2) records the holder-wait clock: a start when the planner first says fix_lease_wait, an end on any other decision
 * except the relay's own pool intent.
 * The ledger writes go through `ledger scheduler-fix-relay` under the scheduler identity, like every tick write.
 * tests/lend-fix-reassign.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { LedgerError, listEvents } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import type { PlannerDecision } from "./scheduler-plan.js";
import { heldLease } from "./ledger-lend-lease.js";
import { POOL_RECIPIENT } from "./scheduler-pool-plan.js";
import { FIX_LEASE_WAIT_CODE, FIX_LEASE_WAIT_OP, leaseWaitOpen } from "./lend-fix-reassign-event.js";
import { closeRelayedPr, relayPrPending, type Gh } from "./lend-fix-reassign-pr.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
const RETRY_MS = 60_000;
/** Per ledger, per card: no gh retry before this time after a failed close (a hard failure must not run gh every pass). */
const retryAt = new WeakMap<Database, Map<string, number>>();

/** The fix stage's entry seq: the holder-wait clock never spans two fix rounds. */
const fixSince = (events: readonly { seq: number; kind: string; data: Record<string, unknown> }[]): number =>
  events.findLast((e) => e.kind === "stage" && e.data.to === "fix")?.seq ?? 0;

/** Structural CLI port: lib stays independent of the manager (same as scheduler-family-pick-notice.ts). */
interface RelayCommand {
  db: Database; p: { pos: string[] }; ctx(): WriteCtx; need(flag: string): string; task(id: string | undefined): LedgerTask; deps: { relayGh?: Gh };
}

export const fixRelayCommand = {
  valued: ["op", "rev"], bools: [],
  usage: "scheduler-fix-relay <task> --op close-pr|wait-start|wait-end [--rev N]（调度服务专用：自动改派的旧 PR 收尾与等租约方计时）",
  async run(c: RelayCommand): Promise<Record<string, unknown>> {
    const ctx = c.ctx(), op = c.need("op");
    if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "自动改派的收尾只由调度服务记账");
    if (op === "close-pr") return { ok: true, relayPr: await closeRelayedPr(c.db, ctx, c.p.pos[1], c.deps.relayGh) };
    if (op !== "wait-start" && op !== "wait-end") throw new LedgerError("invalid", "--op 只能是 close-pr / wait-start / wait-end");
    return tx(c.db, () => {
      const task = c.task(c.p.pos[1]);
      if (op === "wait-start" && (task.stage !== "fix" || task.rev !== Number(c.need("rev")) || getWorkflow(c.db, task.id)?.mode !== "auto")) {
        throw new LedgerError("conflict", "卡已不在这次自动修复等待状态");
      }
      const events = listEvents(c.db, { project: task.project, target: task.id }), since = fixSince(events);
      const open = leaseWaitOpen(events, since);
      if ((op === "wait-start") === !!open) return { ok: true, changed: false };
      const state = op === "wait-start" ? "start" : "end";
      const e = insertEvent(c.db, { actor: ctx.actor, now: ctx.now, dedupKey: `scheduler:fix-lease-wait:${task.id}:${open?.seq ?? since}:${state}` }, {
        project: task.project, target: task.id, kind: "scheduler", text: state === "start" ? "修复单开始等写租约方（自动改派计时起点）" : "修复单不再等写租约方（计时清零）",
        data: { op: FIX_LEASE_WAIT_OP, state, round: task.round, head: task.headSHA },
      }, true);
      return { ok: true, changed: true, seq: e.seq };
    });
  },
};

/** Start of a card's pass: retry the old PR's close while a delivered relay still owes it. */
export async function relayPrFollowUp(db: Database, task: LedgerTask, manager: Manager, now: number): Promise<void> {
  const tries = retryAt.get(db) ?? new Map<string, number>();
  retryAt.set(db, tries);
  if (!relayPrPending(db, task) || (tries.get(task.id) ?? 0) > now) return;
  const r = await manager("ledger", "scheduler-fix-relay", task.id, "--op", "close-pr");
  const res = r.relayPr as { closed: boolean; text: string } | null | undefined;
  if (r.ok === true && (!res || res.closed)) { tries.delete(task.id); return; }
  tries.set(task.id, now + RETRY_MS);
  console.error(`⚠️ [scheduler] ${task.id} 自动改派的旧 PR 收尾没完成，${RETRY_MS / 1000}s 后重试：${String(res?.text ?? r.error)}`);
}

/** After the card's plan: open the holder-wait clock on fix_lease_wait, close it on any other decision. */
export async function trackLeaseWait(db: Database, task: LedgerTask, plan: PlannerDecision, manager: Manager): Promise<void> {
  if (task.stage !== "fix") return;
  // The relay's own pool intent keeps the stretch open: the offer re-plans and must still see the clock past the threshold.
  const holder = heldLease(db, task)?.peer;
  const relaying = plan.kind === "intent" && !!holder && !!plan.recipient?.startsWith(POOL_RECIPIENT) && plan.recipient !== `${POOL_RECIPIENT}${holder}`;
  const waiting = relaying || (plan.kind === "wait" && plan.code === FIX_LEASE_WAIT_CODE);
  const events = listEvents(db, { project: task.project, target: task.id });
  if (waiting === !!leaseWaitOpen(events, fixSince(events))) return;
  const r = await manager("ledger", "scheduler-fix-relay", task.id, "--op", waiting ? "wait-start" : "wait-end", "--rev", String(task.rev));
  if (r.ok !== true) console.error(`⚠️ [scheduler] ${task.id} 等写租约方计时没记上，下轮重试：${String(r.error)}`);
}
