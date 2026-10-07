/**
 * Handoff gates (HDG-1, docs/architecture/dag-tools.md「交接闸」): two machine-readable reasons a reviewed card in `merge` is not
 * handed over (or locally merged) yet. (1) The project's handoff hold, set by PM / owner: build / fix / review keep going, only the
 * step out of `merge` waits — unlike `ledger freeze`, which stops new work too. (2) A card bound to a feature DAG node waits until
 * every node of the DAG's current version is reviewed at its head in `merge`, already handed, or finished; then the batch goes out
 * in dependency order. A handoff already recorded is never taken back. tests/handoff-gate*.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { LedgerEvent, LedgerTask, Stage } from "./ledger-stages.js";
import { handedInStay, handoffGateWait, type FeatureGate, type GateNode, type HandoffGateFacts, type NodeState } from "./handoff-gate-plan.js";
import { getMeta, getTask, listEvents } from "./ledger-store.js";
import { effectiveNodes, getDagVersion, getFeature } from "./ledger-feature.js";
import { currentReviewFacts } from "./scheduler-review.js";

const DONE: readonly Stage[] = ["live", "verified", "done", "cancelled"];

/**
 * Reviewed at the card's current head (or one a recorded carry reached) with no P0 / P1 after downgrades and arbitration. The card's
 * own merge proof stays with its own merge / handoff; a sibling only has to show a passing verdict at its head.
 */
function reviewed(task: LedgerTask, events: readonly LedgerEvent[]): boolean {
  const r = currentReviewFacts(task, events);
  return r.kind === "facts" && ["pass", "changes"].includes(r.facts.verdict) && !r.facts.findings.some((f) => f.severity === "P0" || f.severity === "P1");
}

/** A card's state for a batch: null = no such card. */
export function cardState(db: Database, taskId: string): { task: LedgerTask; state: NodeState } | null {
  const t = getTask(db, taskId);
  if (!t) return null;
  if (DONE.includes(t.stage)) return { task: t, state: "done" };
  if (t.stage !== "merge") return { task: t, state: "pending" };
  const events = listEvents(db, { project: t.project, target: t.id });
  return { task: t, state: handedInStay(events) ? "handed" : reviewed(t, events) ? "ready" : "pending" };
}

function nodeOf(db: Database, n: { key: string; taskId: string | null; deps: string[] }): GateNode {
  const base = { key: n.key, taskId: n.taskId, deps: n.deps };
  const c = n.taskId ? cardState(db, n.taskId) : null;
  if (!c) return { ...base, state: "pending", stage: n.taskId ? "missing" : "planned", head: null, round: null };
  return { ...base, state: c.state, stage: c.task.stage, head: c.task.headSHA, round: c.task.round };
}

/** null = the card is in no feature DAG's current version, or that DAG has a single node: nothing to wait for. */
function featureGate(db: Database, task: LedgerTask): FeatureGate | null {
  const f = task.featureId ? getFeature(db, task.featureId) : null;
  const v = f?.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
  if (!f || !v) return null;
  const nodes = effectiveNodes(db, v);
  const self = nodes.find((n) => n.taskId === task.id);
  if (!self || nodes.length < 2) return null;
  return { featureId: f.id, version: v.version, self: self.key, nodes: nodes.map((n) => nodeOf(db, n)) };
}

export function handoffGateFacts(db: Database, task: LedgerTask): HandoffGateFacts {
  const hold = getMeta(db, task.project).handoffHold;
  return { hold: hold.on ? hold : null, feature: featureGate(db, task) };
}

/**
 * The authoritative writes' check (merge intent, merge run start / drift, manual queue claim): both gates as one refusal text.
 * `begun` = the effect checked is a merge run already begun. beginMergeRun refuses under the hold in its own transaction, so a run
 * exists only if it began before the hold went on: exempt from the hold (never recalled), not from the feature batch.
 */
export function handoffGateRefusal(db: Database, task: LedgerTask, begun = false): string | null {
  const facts = handoffGateFacts(db, task);
  const w = handoffGateWait({ hold: begun ? null : facts.hold, feature: facts.feature });
  return w && `${w.code}：${w.reason}`;
}
