/**
 * UIASK1: an ownerVisual card whose newest scheduler screenshot ask the owner approved on an older head / specRev / digest;
 * `uiOwnerReask` (recovery-keys.ts) decides whether the scheduler reopens it for the current values. A binding that already has
 * a scheduler ask keeps that ask's branch (currentBindingGate). The planner cannot write: observe records wait in this process's
 * outbox until drainUiOwnerReaskObserved. Docs: docs/architecture/scheduler-ui-gate.md. Tests: tests/scheduler-ui-reask.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { listEvents } from "./ledger-store.js";
import { recoveryPolicy, type ObservedAction, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { PlannerSnapshot } from "./scheduler-plan.js";
import { ownerVisualOf, uiMergeRefusal } from "./scheduler-ui-merge-refusal.js";

const KEY = "uiOwnerReask";
const OUTBOX_MAX = 500;
const outbox = new Map<string, ObservedAction>();

type UiGate = PlannerSnapshot["uiGate"];
type Card = Pick<PlannerSnapshot, "task" | "screenshotsDigest">;

type Bound = { head?: string; specRev?: number; screenshotsDigest?: string };

/**
 * The newest scheduler ask is bound to other values but an older one (open, answered or expired) to the card's current ones, on
 * an ownerVisual card: that older ask decides, so a binding that went A → B → A never gets a second ask. Null = the newest decides.
 * Its approval releases the card only when the merge write (uiMergeRefusal, newest 20 answered asks) finds it too; one the write
 * cannot see reads as unverified, so the card goes to a person (ui_unverified) instead of a merge the write refuses, or a reopen.
 */
export function currentBindingGate(db: Database, task: LedgerTask, newest: UiGate,
  older: Iterable<{ bound: Bound; gate: () => UiGate }>, now: number): UiGate | null {
  const digest = task.extra.screenshotsDigest;
  const current = (b: Bound) => b.head === task.headSHA && b.specRev === task.specRev && b.screenshotsDigest === digest;
  if (newest.state === "none" || typeof digest !== "string" || !task.headSHA || current(newest)) return null;
  let hit: { gate: () => UiGate } | undefined;
  for (const o of older) if (current(o.bound)) { hit = o; break; }
  if (!hit || !ownerVisualOf(db, task, listEvents(db, { project: task.project, target: task.id }))) return null;
  const gate = hit.gate();
  return gate.state === "approved" && gate.ownerVerified && uiMergeRefusal(db, task, now) !== null ? { ...gate, ownerVerified: false } : gate;
}

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
