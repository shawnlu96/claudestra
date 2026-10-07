/** Pure side of the handoff gates (handoff-gate.ts reads the facts): the planner and the handoff write judge with the same code. */
import type { LedgerEvent, Stage } from "./ledger-stages.js";
import type { HandoffHold } from "./ledger-store.js";

/** handed: this stay in `merge` has a handoff record; done: merged or finished (or cancelled — it no longer holds the batch). */
export type NodeState = "pending" | "ready" | "handed" | "done";
export interface GateNode { key: string; taskId: string | null; deps: string[]; state: NodeState; stage: Stage | "planned" | "missing"; head: string | null; round: number | null }
export interface FeatureGate { featureId: string; version: number; self: string; nodes: GateNode[] }
export interface HandoffGateFacts { hold: HandoffHold | null; feature: FeatureGate | null }

/** The card's latest entry into `merge`: a handoff belongs to one stay there, a card that comes back hands over again. */
export const mergeEntry = (events: readonly LedgerEvent[]): number => events.findLast((e) => e.kind === "stage" && e.data.to === "merge")?.seq ?? 0;
export const handedInStay = (events: readonly LedgerEvent[]): boolean => {
  const since = mergeEntry(events);
  return events.some((e) => e.seq > since && e.kind === "scheduler" && e.data.op === "merge_handoff");
};

const nodeLabel = (n: GateNode): string => `${n.key}（${n.taskId ?? "未开卡"}${n.stage === "planned" ? "" : ` ${n.stage}`}）`;

/** Every node `key` depends on, directly or through others. */
function upstream(nodes: readonly GateNode[], key: string): GateNode[] {
  const byKey = new Map(nodes.map((n) => [n.key, n])), seen = new Set<string>(), out: GateNode[] = [];
  const walk = (k: string) => {
    for (const d of byKey.get(k)?.deps ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      const n = byKey.get(d);
      if (n) { out.push(n); walk(d); }
    }
  };
  walk(key);
  return out;
}

/**
 * Which nodes go out together with `self` — the one place to change when the dependency semantics change (spec clarification 1).
 * Today a successor starts only once its dependency is live, so a node something depends on hands over alone (else it and its
 * successor would wait on each other forever); any other node goes with every node it has no dependency path to.
 */
export function batchWith(nodes: readonly GateNode[], self: string): string[] {
  if (nodes.some((n) => upstream(nodes, n.key).some((u) => u.key === self))) return [self];
  const above = new Set(upstream(nodes, self).map((n) => n.key));
  return nodes.filter((n) => !above.has(n.key)).map((n) => n.key);
}

const others = (f: FeatureGate): GateNode[] => {
  const batch = new Set(batchWith(f.nodes, f.self));
  return f.nodes.filter((n) => n.key !== f.self && batch.has(n.key));
};

const batchPending = (f: FeatureGate): GateNode[] => others(f).filter((n) => n.state === "pending");
/** The cards this card's node depends on, directly or not: an upstream sent back after it went out holds its successor too. */
export const upstreamCards = (f: FeatureGate): string[] => upstream(f.nodes, f.self).flatMap((n) => n.taskId ? [n.taskId] : []);
/** Wait codes of the gates: a card held by any of them may be the one left to tell PM a handed batch fell back. */
export const HANDOFF_GATE_CODES: readonly string[] = ["handoff_hold", "feature_siblings_pending", "feature_handoff_order"];

/**
 * Pure: why this card may not leave `merge` yet, both gates together (the stricter wins), or null. Every upstream node must be
 * handed or finished first: a ready one goes first (order), one not reviewed — never started, or sent back after it went out — holds.
 */
export function handoffGateWait(facts: HandoffGateFacts): { code: string; reason: string } | null {
  const why: string[] = [];
  let code: string | null = null;
  if (facts.hold) {
    code = "handoff_hold";
    why.push(`项目暂停交接（${facts.hold.by ?? "?"}）：${facts.hold.reason || "未写理由"}`);
  }
  const f = facts.feature;
  if (f) {
    const pending = batchPending(f), above = upstream(f.nodes, f.self);
    const behind = above.filter((n) => n.state === "pending"), first = above.filter((n) => n.state === "ready");
    if (pending.length || behind.length) {
      code ??= "feature_siblings_pending";
      if (pending.length) why.push(`feature ${f.featureId} v${f.version} 同批还有节点没审过：${pending.map(nodeLabel).join("、")}`);
      if (behind.length) why.push(`feature ${f.featureId} v${f.version} 依赖的节点没审过：${behind.map(nodeLabel).join("、")}`);
    } else if (first.length) {
      code ??= "feature_handoff_order";
      why.push(`feature ${f.featureId} 按依赖先交被依赖的：${first.map(nodeLabel).join("、")}`);
    }
  }
  return code ? { code, reason: why.join("；") } : null;
}

/** The batch a feature handoff goes out with: its nodes in `merge` as card@head, dependencies first. */
export function featureBatch(f: FeatureGate): string[] {
  const batch = new Set(batchWith(f.nodes, f.self)), order: GateNode[] = [], placed = new Set<string>();
  const place = (n: GateNode) => {
    if (placed.has(n.key)) return;
    placed.add(n.key);
    for (const d of upstream(f.nodes, n.key)) place(d);
    order.push(n);
  };
  f.nodes.forEach(place);
  return order.filter((n) => batch.has(n.key) && (n.state === "ready" || n.state === "handed")).map((n) => `${n.taskId}@${n.head ?? ""}`);
}
