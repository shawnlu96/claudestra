/**
 * dispatch-recovery-PEERLEASE1 · peerLeaseRecovery's tick half, after the card's plan (lend-fix-reassign-tick.ts trackLeaseWait). The
 * planner only reads; every write goes through the scheduler identity's ledger CLI:
 * - observe's relay note: the planner tags the holder wait with the would-be relay or why there is none (recovery-peer-lease.ts); one
 *   `scheduler-recovery-observe` note per card / spec / round / head / holder / wait stretch / outcome;
 * - the peer author handover (recovery-peer-lease-handover.ts): off = nothing; observe = one note per would-be handover or block;
 *   on = `scheduler-fix-relay --op peer-handover` with the session and lease generation assessed here and the runtime a new local
 *   author would be created in now (frozen on the event). The transaction re-reads the switch and every proof; a block is noted, the
 *   card is never forced (no slot freed, no binding retired without the proofs).
 * tests/recovery-peer-lease-tick.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, listEvents } from "./ledger-store.js";
import type { PlannerDecision } from "./scheduler-plan.js";
import { observeDedupKey } from "./recovery-policy.js";
import { heldLease } from "./ledger-lend-lease.js";
import { FIX_LEASE_WAIT_CODE, leaseWaitOpen } from "./lend-fix-reassign-event.js";
import { observedTag, PEER_LEASE_KEY, peerLeaseMode, peerLeasePorts, relayObserveKey } from "./recovery-peer-lease.js";
import { handoverCheck, handoverObserveKey } from "./recovery-peer-lease-handover.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;

const fixSince = (events: readonly { seq: number; kind: string; data: Record<string, unknown> }[]): number =>
  events.findLast((e) => e.kind === "stage" && e.data.to === "fix")?.seq ?? 0;

/** One observe note, skipped without a manager call when already on the ledger. */
async function note(db: Database, task: LedgerTask, manager: Manager, actionKey: string, action: string, data: Record<string, unknown>): Promise<void> {
  if (getEventByDedup(db, observeDedupKey({ project: task.project, mechanism: PEER_LEASE_KEY, target: task.id, actionKey }))) return;
  const r = await manager("ledger", "scheduler-recovery-observe", task.id, "--mechanism", PEER_LEASE_KEY, "--action-key", actionKey,
    "--action", action.slice(0, 500), "--data", JSON.stringify(data));
  if (r.ok !== true) console.error(`⚠️ [scheduler] ${task.id} ${PEER_LEASE_KEY} 观察没记上，下轮重试：${String(r.error)}`);
}

async function observeRelay(db: Database, task: LedgerTask, plan: PlannerDecision, manager: Manager): Promise<void> {
  const seen = plan.kind === "wait" && plan.code === FIX_LEASE_WAIT_CODE ? observedTag(plan.reason) : null;
  const holder = seen ? heldLease(db, task)?.peer : null;
  if (!seen || !holder || !task.headSHA) return;
  const events = listEvents(db, { project: task.project, target: task.id });
  const stretch = leaseWaitOpen(events, fixSince(events))?.seq ?? 0;
  await note(db, task, manager, relayObserveKey(task.id, { specRev: task.specRev, round: task.round, head: task.headSHA }, holder, stretch, seen),
    `池模式改派：${seen}`, { kind: "relay", holder, stretch, round: task.round, specRev: task.specRev, head: task.headSHA });
}

/** The family a new local author would be created in now: the same choice as scheduler-local-author.ts launch. */
async function runtimeNow(db: Database, project: string): Promise<AuthorFamily> {
  const port = peerLeasePorts(db).authorRuntime;
  if (port) return port(project);
  const agents = (await import("./scheduler-config.js")).readSchedulerConfig().projects[project]?.agents;
  return agents ? (await import("./scheduler-agent-pool-runtime.js")).poolAuthorRuntime(project, agents, db.filename)
    : (await import("./scheduler-local-runtime.js")).localAuthorRuntime(project);
}

async function handover(db: Database, task: LedgerTask, manager: Manager): Promise<void> {
  if (task.stage !== "fix") return;
  const mode = peerLeaseMode(db, task.project);
  if (mode === "off") return;
  const c = handoverCheck(db, task);
  if (!("evidence" in c)) {
    if (c.relevant) await note(db, task, manager, handoverObserveKey(task.id, c), `peer 作者交接阻断：${c.why}`, { kind: "handover_blocked", why: c.why });
    return;
  }
  const ev = c.evidence;
  if (mode === "observe") {
    await note(db, task, manager, handoverObserveKey(task.id, c), `本会让 peer 作者 ${ev.agent}（${ev.family}）的绑定退出 active，再由本机建修复作者`,
      { kind: "handover", evidence: ev });
    return;
  }
  let runtime: AuthorFamily;
  try { runtime = await runtimeNow(db, task.project); }
  catch (e) { console.error(`⚠️ [scheduler] ${task.id} 读不到本机作者运行时，交接下轮再试：${(e as Error).message}`); return; }
  const r = await manager("ledger", "scheduler-fix-relay", task.id, "--op", "peer-handover", "--rev", String(task.rev), "--session", ev.sessionId,
    "--lease-at", String(ev.leaseAt), "--runtime", runtime);
  if (r.ok !== true) console.error(`⚠️ [scheduler] ${task.id} peer 作者交接没记上，下轮重算：${String(r.error)}`);
}

/** After the card's plan, before the clock: both halves are independent and each is idempotent. */
export async function peerLeaseTick(db: Database, task: LedgerTask, plan: PlannerDecision, manager: Manager): Promise<void> {
  if (task.stage !== "fix") return;
  await observeRelay(db, task, plan, manager);
  await handover(db, task, manager);
}
