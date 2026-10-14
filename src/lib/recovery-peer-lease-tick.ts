/**
 * dispatch-recovery-PEERLEASE1 · peerLeaseRecovery's tick half, after the card's plan (lend-fix-reassign-tick.ts trackLeaseWait). The
 * planner only reads; every write goes through the scheduler identity's ledger CLI:
 * - observe's relay note: the planner tags the holder wait with the would-be relay or why there is none (recovery-peer-lease.ts); one
 *   `scheduler-recovery-observe` note per card / spec / round / head / holder / wait stretch / outcome;
 * - the peer author handover (recovery-peer-lease-handover.ts): off = nothing; observe = one note per would-be handover or block;
 *   a lease branch whose remote head is unreadable or past the ledger's head is a block (recovery-peer-lease-head.ts): observe notes it,
 *   on records it (`--op peer-head-block`, the rev moves), never handed over;
 *   on = `scheduler-fix-relay --op peer-handover` with the session and lease generation assessed here and the runtime a new local
 *   author would be created in now (frozen on the event). The transaction re-reads the switch and every proof; a block is noted, the
 *   card is never forced (no slot freed, no binding retired without the proofs). scheduler-local-author.ts creates in that frozen
 *   runtime (recovery-peer-lease-family.ts handoverRuntime); a local binding in another family is noted once (runtime_drift).
 * tests/recovery-peer-lease-tick.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getTask, listEvents } from "./ledger-store.js";
import type { PlannerDecision } from "./scheduler-plan.js";
import { observeDedupKey } from "./recovery-policy.js";
import { heldLease } from "./ledger-lend-lease.js";
import { FIX_LEASE_WAIT_CODE, leaseWaitOpen } from "./lend-fix-reassign-event.js";
import { observedTag, PEER_LEASE_KEY, peerLeaseMode, peerLeasePorts, relayObserveKey } from "./recovery-peer-lease.js";
import { handoverCheck, handoverObserveKey } from "./recovery-peer-lease-handover.js";
import { handoverRuntimeDrift } from "./recovery-peer-lease-family.js";
import { probeHandoverHead } from "./recovery-peer-lease-head.js";
import { getSchedulerSession, taskWorkerRefs } from "./scheduler-sessions.js";

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
  const head = await probeHandoverHead(db, ev); // the stop report is no preservation: the lease branch must stand at the ledger's head
  if (head.why && mode === "observe") {
    await note(db, task, manager, handoverObserveKey(task.id, { why: head.why, relevant: true }), `peer 作者交接阻断：${head.why}`, { kind: "handover_blocked", why: head.why });
    return;
  }
  if (head.why) { // on: recorded once, the rev moves (this tick's plan is refused); the next snapshot plans on the old row again
    const r = await manager("ledger", "scheduler-fix-relay", task.id, "--op", "peer-head-block", "--rev", String(task.rev), "--session", ev.sessionId,
      "--lease-at", String(ev.leaseAt));
    if (r.ok !== true) console.error(`⚠️ [scheduler] ${task.id} peer 作者交接阻断没记上，下轮重算：${String(r.error)}`);
    return;
  }
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

/** A local author bound in another family than the handover froze: the snapshot keeps the old source (gate refuses); noted once. */
async function observeDrift(db: Database, task: LedgerTask, manager: Manager): Promise<void> {
  if (peerLeaseMode(db, task.project) === "off") return;
  const author = taskWorkerRefs(db, task.id).author, drift = handoverRuntimeDrift(db, task, author);
  if (!drift || !author) return;
  const key = `runtime-drift:${createHash("sha256").update(JSON.stringify([task.id, author.sessionId, drift])).digest("hex").slice(0, 32)}`;
  await note(db, task, manager, key, `交接冻结 ${drift.frozen}，本机作者 ${author.agent} 却绑成 ${drift.bound}：不按它判作者家族，等 PM 核对`,
    { kind: "runtime_drift", ...drift, agent: author.agent, sessionId: author.sessionId });
}

/** Thrown out of the card's step (scheduler-auto-tick.ts records it in failed): this tick's plan must not run. */
export class PeerHandoverHalt extends Error {}

/**
 * The fence after the handover: a plan to create the card's author while a peer author binding is still active was made on the
 * snapshot that dropped that row (handoverDue) — the planner never asks for a new author next to a bound one. If the handover did
 * not land (refused re-check, unread runtime, failed manager call, switch flipped) and nothing moved the rev (a head block does), the
 * plan's own rev CAS would accept it: the card's step stops here instead, before any creation. Reads only; the next snapshot re-plans.
 */
function staleAuthorPlan(db: Database, task: LedgerTask, plan: PlannerDecision): string | null {
  if (plan.kind !== "intent" || plan.action !== "ensure_session" || (plan.sessionRole ?? "author") !== "author") return null;
  if (getTask(db, task.id)?.rev !== task.rev) return null; // the plan's rev CAS refuses it
  const row = getSchedulerSession(db, task.id, "author");
  return row?.state === "active" && row.transport === "peer"
    ? `${task.id} peer 作者 ${row.agent} 的绑定未交接，本轮建作者的计划作废（不建本机作者），下轮重算` : null;
}

/** After the card's plan, before the clock: the halves are independent and each is idempotent; the fence runs last. */
export async function peerLeaseTick(db: Database, task: LedgerTask, plan: PlannerDecision, manager: Manager): Promise<void> {
  if (task.stage !== "fix") return;
  await observeRelay(db, task, plan, manager);
  await handover(db, task, manager);
  await observeDrift(db, task, manager);
  const stale = staleAuthorPlan(db, task, plan);
  if (stale) throw new PeerHandoverHalt(stale);
}
