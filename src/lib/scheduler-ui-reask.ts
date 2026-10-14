/**
 * UIASK1: an ownerVisual card whose newest scheduler screenshot ask the owner approved, but on an older head / specRev / digest.
 * Switch `uiOwnerReask` (recovery-keys.ts, default observe): off = escalate ui_stale as before; observe = the same escalation plus
 * one would-reopen record per card and binding; on = plan a new owner ask bound to the card's current values (scheduler-apply.ts
 * opens it under the same askKey). A rejected or unverified answer is never reopened; once the scheduler's ask for the current
 * values exists it is the newest and bound, so the planner never gets here again for that binding.
 * The planner reads through the scheduler's query_only connection: the would-be record waits in this process's outbox until a
 * caller with a ledger write drains it (drainUiOwnerReaskObserved; recordObserved dedups, so a replay never records twice).
 * Docs: docs/architecture/scheduler-ui-gate.md. Tests: tests/scheduler-ui-reask.test.ts.
 */
import { recoveryPolicy, type ObservedAction, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { PlannerSnapshot } from "./scheduler-plan.js";

const KEY = "uiOwnerReask";
const OUTBOX_MAX = 500;
const outbox = new Map<string, ObservedAction>();

type UiGate = PlannerSnapshot["uiGate"];
type Card = Pick<PlannerSnapshot, "task" | "screenshotsDigest">;

/** Read every time; an unreadable file / unknown key is off (the escalation as before). */
export function uiOwnerReaskMode(project: string, policy: RecoveryPolicyPort = recoveryPolicy): RecoveryMode {
  try { const p = policy(project, KEY); return p.source === "error" ? "off" : p.mode; } catch { return "off"; }
}

/**
 * Called only with an ownerVisual card's stale owner gate. `{ kind: "ask_owner" }` = reopen for the current values; null = the
 * caller escalates ui_stale as before (off, observe, or not an owner-approved answer).
 */
export function ownerReask(s: Card, owner: UiGate, policy?: RecoveryPolicyPort): { kind: "ask_owner" } | null {
  if (owner.state !== "approved" || owner.ownerVerified !== true || !s.task.headSHA || !s.screenshotsDigest) return null;
  const mode = uiOwnerReaskMode(s.task.project, policy);
  if (mode === "on") return { kind: "ask_owner" };
  if (mode === "observe") queue(s, owner);
  return null;
}

function queue(s: Card, owner: UiGate): void {
  const to = { head: s.task.headSHA as string, specRev: s.task.specRev, screenshotsDigest: s.screenshotsDigest as string };
  const from = { head: owner.head ?? null, specRev: owner.specRev ?? null, screenshotsDigest: owner.screenshotsDigest ?? null };
  const actionKey = `ui-reask:${to.head}:s${to.specRev}:${to.screenshotsDigest.slice(0, 16)}`;
  const id = `${s.task.project}\0${s.task.id}\0${actionKey}`;
  if (outbox.has(id) || outbox.size >= OUTBOX_MAX) return;
  outbox.set(id, { project: s.task.project, mechanism: KEY, target: s.task.id, actionKey,
    action: `重开 owner 截图 ask（owner 批准过的绑定 head ${String(from.head).slice(0, 12)} / 规格第 ${from.specRev} 版已过期，` +
      `新绑定 head ${to.head.slice(0, 12)} / 规格第 ${to.specRev} 版）`,
    data: { from, to } });
}

/** Would-be records waiting for a writer, oldest first. */
export const uiOwnerReaskPending = (): ObservedAction[] => [...outbox.values()];

/**
 * Hand every waiting record to `observe` (recordObserved, or the scheduler identity's `ledger scheduler-recovery-observe`).
 * A record whose write throws goes back in the queue for the next drain. Returns how many were handed over.
 */
export async function drainUiOwnerReaskObserved(observe: (a: ObservedAction) => void | Promise<void>): Promise<number> {
  let done = 0;
  for (const [id, a] of [...outbox]) {
    outbox.delete(id);
    try { await observe(a); done++; } catch { if (outbox.size < OUTBOX_MAX) outbox.set(id, a); }
  }
  return done;
}

/** Tests only: forget this process's queue. */
export function resetUiOwnerReaskObserved(): void { outbox.clear(); }
