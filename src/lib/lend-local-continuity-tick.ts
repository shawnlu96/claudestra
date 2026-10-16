/**
 * i28-STALELEASE1 · staleLeaseHandover's tick half, run by the auto tick (scheduler-auto-tick.ts) for a fix card with no open intent,
 * before its snapshot — so before placement and pooling, in pool and non-pool mode alike. The planner itself never changes: once the
 * stale lease has ended, the next snapshot has no lease holder and FB1 (lend-fix-start.ts localFixOwner) sends the fix to the
 * card's own author session — no new session, no rebind, no peer intent, no probe of the old lend branch.
 * - off: nothing read, nothing written.
 * - observe: one `scheduler-recovery-observe` sample per card and lease generation; lease and dispatch unchanged.
 * - on: `scheduler-fix-relay --op stale-lease-handover` (lend-local-continuity-apply.ts re-checks everything in its transaction);
 *   a recorded handover ends this tick's step (replan), a refused one leaves the card to today's path and the next tick recomputes.
 * Both need the same dry run first: the card's snapshot without the lease (and without the holder's pin) places the fix here.
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup } from "./ledger-store.js";
import { continuityCheck, STALE_LEASE_KEY, staleLeaseMode, staleLeaseObserveKey, type ContinuityEvidence } from "./lend-local-continuity.js";
import { observeDedupKey } from "./recovery-policy.js";
import type { PlannerSnapshot } from "./scheduler-plan.js";
import type { SnapshotOpts } from "./scheduler-snapshot.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;

/** The snapshot as it reads once the handover committed: no lease holder, the holder's pin gone; null = the fix would not land here. */
async function landsHere(db: Database, task: LedgerTask, opts: SnapshotOpts, ev: ContinuityEvidence): Promise<boolean> {
  const { autoSnapshot } = await import("./scheduler-auto-snapshot.js");
  const { remoteWork } = await import("./scheduler-placement-plan.js");
  const s = autoSnapshot(db, task, opts);
  const extra = ev.unpin ? Object.fromEntries(Object.entries(task.extra).filter(([k]) => k !== "placement")) : task.extra;
  const dry: PlannerSnapshot = { ...s, task: { ...s.task, extra }, pool: s.pool ? { ...s.pool, writeLeasePeer: null } : s.pool };
  const since = s.events.findLast((e) => e.kind === "stage" && e.data.to === task.stage)?.seq ?? s.events.find((e) => e.kind === "task")?.seq ?? 0;
  return dry.author?.sessionId === ev.sessionId && dry.author.source === "local" && remoteWork(dry, since, "fix") === null;
}

/** null = carry on with the card's step as today; a string = the handover was recorded, end this step (the next tick plans). */
export async function staleLeaseStep(db: Database, task: LedgerTask, opts: SnapshotOpts, manager: Manager): Promise<string | null> {
  if (task.stage !== "fix") return null;
  const mode = staleLeaseMode(db, task.project);
  if (mode === "off") return null;
  const c = continuityCheck(db, task);
  if (!c.ok || !(await landsHere(db, task, opts, c.evidence))) return null;
  const ev = c.evidence;
  if (mode === "observe") {
    const actionKey = staleLeaseObserveKey(task.id, ev);
    if (getEventByDedup(db, observeDedupKey({ project: task.project, mechanism: STALE_LEASE_KEY, target: task.id, actionKey }))) return null;
    const r = await manager("ledger", "scheduler-recovery-observe", task.id, "--mechanism", STALE_LEASE_KEY, "--action-key", actionKey,
      "--action", `本来会结束 ${ev.peer} 的写租约，把 fix 派给 ${ev.agent}`.slice(0, 500), "--data", JSON.stringify({ kind: "handover", ...ev }));
    if (r.ok !== true) console.error(`⚠️ [scheduler] ${task.id} ${STALE_LEASE_KEY} 观察没记上，下轮重试：${String(r.error)}`);
    return null;
  }
  const r = await manager("ledger", "scheduler-fix-relay", task.id, "--op", "stale-lease-handover", "--rev", String(task.rev),
    "--session", ev.sessionId, "--lease-at", String(ev.leaseAt));
  if (r.ok !== true) {
    console.error(`⚠️ [scheduler] ${task.id} 结束旧写租约没成，照旧派单、下轮重算：${String(r.error)}`);
    return null;
  }
  return `本机原作者接手：已结束 ${ev.peer} 的写租约，下一轮把修复派给 ${ev.agent}`;
}
