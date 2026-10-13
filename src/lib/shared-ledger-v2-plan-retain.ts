/**
 * S2F4 · the home's original plan proposal, kept in process between S2Q's `intent.create` and the projection that lands the
 * center intent. The center has no recipient field and its reason / causalSeq differ from the home's, so only this snapshot can
 * fill the local row's recipient and let a replay of the same key compare against the decision that was actually made.
 * Never persisted: after a restart (or once an entry is pushed out) the row lands without a recipient and the dispatch driver
 * cancels and replans it under a new key. Nothing here throws, and nothing here writes the ledger itself: the projection
 * writer passes its own event write in as a callback.
 */
import type { Database } from "bun:sqlite";
import type { PlanIntentInput } from "./ledger-scheduler-write.js";
import { PROJECTED_ACTIONS } from "./shared-ledger-v2-projection-rows.js";

/** schedulerV2PlanProposal's result: resources are the home's own keys (sorted, unique), never the center's structured keys. */
export interface RetainedPlan {
  id: string; taskId: string; workflowRev: number; resources: string[]; node: string; action: string;
  recipient?: string; reason: string; taskRev: number; causalSeq: number;
}
export const PLAN_RETAIN_LIMIT = 256;
const PLAN_KEY = "scheduler:";
const store = new Map<string, RetainedPlan>();

const copy = (p: RetainedPlan): RetainedPlan => ({ ...p, resources: [...p.resources] });

/** Keep the proposal under its intent id (= the center intent's operationId); past the limit the oldest entry is dropped. */
export function retainPlan(p: PlanIntentInput, resources: readonly string[] = p.resources ?? []): void {
  store.delete(p.id);
  store.set(p.id, { id: p.id, taskId: p.taskId, workflowRev: p.workflowRev, resources: [...new Set(resources)].sort(), node: p.node,
    action: p.action, ...(p.recipient === undefined ? {} : { recipient: p.recipient }), reason: p.reason, taskRev: p.taskRev, causalSeq: p.causalSeq });
  while (store.size > PLAN_RETAIN_LIMIT) store.delete(store.keys().next().value!);
}
/** Read-only lookup (a copy): only a committed projection removes an entry. */
export function retainedPlan(intentId: string): RetainedPlan | null {
  const p = store.get(intentId);
  return p ? copy(p) : null;
}
export function retainedPlanCount(): number { return store.size; }
export function clearRetainedPlans(): void { store.clear(); }

type ViewIntent = { operationId: string; taskId: string; node: string; action: string };
/** The write gate's "intents of this view" set: operationId → taskId of every intent this projection may land a row for. */
export function planIntents(intents: readonly ViewIntent[]): ReadonlyMap<string, string> {
  return new Map(intents.filter(i => PROJECTED_ACTIONS.includes(i.action)).map(i => [i.operationId, i.taskId]));
}

export interface PlanLanding {
  /** Insert path only: the retained recipient when the proposal is this very intent, otherwise null (nothing is guessed). */
  recipient(intent: ViewIntent): string | null;
  /** Inside the projection transaction: one `scheduler:<id>` plan event per intent whose proposal landed. */
  events(write: (plan: RetainedPlan, dedupKey: string) => void): void;
  /** After the commit only: drop the entries that landed or can never land, and return the mismatches to report. */
  settle(): { taskId: string; intentId: string }[];
}

/**
 * One projection transaction's use of the retained proposals. A rolled-back transaction never reaches `settle`, so its entries
 * stay and the retry lands them. `cards` is the trusted feature's card set: an intent on any other card gets nothing, so the
 * plan event can never be refused by the write gate (this card adds no throwing path).
 */
export function planLanding(db: Database, retained: ((intentId: string) => RetainedPlan | null) | undefined, cards: ReadonlySet<string>): PlanLanding {
  const landed: RetainedPlan[] = [], mismatched: { taskId: string; intentId: string }[] = [];
  return {
    recipient(i) {
      const plan = retained?.(i.operationId) ?? null;
      if (!plan) return null;
      // A key the ledger already holds an event for cannot take the plan event (dedupKey is unique): treated as a mismatch.
      const taken = db.query("SELECT 1 FROM events WHERE dedupKey = ?").get(`${PLAN_KEY}${i.operationId}`);
      if (taken || !cards.has(i.taskId) || plan.id !== i.operationId || plan.taskId !== i.taskId || plan.node !== i.node || plan.action !== i.action) {
        mismatched.push({ taskId: i.taskId, intentId: i.operationId });
        return null;
      }
      landed.push(copy(plan));
      return plan.recipient ?? null;
    },
    events(write) { for (const plan of landed) write(copy(plan), `${PLAN_KEY}${plan.id}`); },
    settle() {
      for (const id of [...landed.map(p => p.id), ...mismatched.map(m => m.intentId)]) store.delete(id);
      return mismatched;
    },
  };
}
