import type { Database } from "bun:sqlite";
import { hasFeatureSchema } from "./ledger-dag-board.js";
import { effectiveNodes, getDagVersion, type Feature } from "./ledger-feature.js";
import { featureDeps } from "./ledger-feature-deps.js";
import { deferredNode, featureEta, phase, projectPace, propagateEtas, type EtaNode } from "./ledger-product-board-eta.js";
import { nodePhase } from "./ledger-dag-rules.js";
import { listEvents, listTasks } from "./ledger-store.js";
import { productFeatureCards } from "./ledger-product-board-cards.js";
import type { LedgerEvent } from "./ledger-stages.js";

export function nodeCounts(nodes: readonly EtaNode[]) {
  const counts = { total: nodes.length, completed: 0, active: 0, ready: 0, blocked: 0, deferred: 0 };
  const completed = new Set(nodes.filter((n) => !deferredNode(n) && phase(n) === "done").map((n) => n.key));
  for (const n of nodes) {
    if (deferredNode(n)) counts.deferred++;
    else if (phase(n) === "done") counts.completed++;
    else if ((n.taskId && !n.task) || n.task?.stage === "blocked") counts.blocked++;
    else if (phase(n) === "active") counts.active++;
    else if (n.deps.every((key) => completed.has(key))) counts.ready++;
    else counts.blocked++;
  }
  return counts;
}

/** Reads only current effective nodes and project-owned tasks. Caller wraps one deferred transaction. */
export function productBoard(db: Database, project: string, now: number) {
  const tasks = listTasks(db, project), own = new Map(tasks.map((t) => [t.id, t]));
  const events = new Map<string, LedgerEvent[]>();
  for (const e of listEvents(db, { project })) {
    const list = events.get(e.target) ?? []; list.push(e); events.set(e.target, list);
  }
  const fs = hasFeatureSchema(db) ? db.query("SELECT * FROM features WHERE project=? ORDER BY id").all(project) as Feature[] : [];
  const entries = fs.map((f) => {
    const v = f.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
    const nodes: EtaNode[] = v ? effectiveNodes(db, v).map((n) => ({ ...n, task: n.taskId ? own.get(n.taskId) ?? null : null })) : [];
    return { f, nodes };
  });
  const all = entries.flatMap((e) => e.nodes), pace = projectPace(all, tasks, events, now);
  const active = all.filter((n) => !deferredNode(n) && phase(n) === "active").length;
  const features = entries.map(({ f, nodes }) => {
    const cards = f.currentVersion ? nodes.flatMap((n) => n.task ? [n.task] : []) : tasks.filter((t) => t.featureId === f.id);
    const counts = f.currentVersion ? nodeCounts(nodes) : { total: cards.length,
      completed: cards.filter((t) => nodePhase(t.id, t.stage) === "done").length,
      active: cards.filter((t) => nodePhase(t.id, t.stage) === "active").length };
    return { id: f.id, title: f.title, status: f.status, hasDag: f.currentVersion > 0, version: f.currentVersion,
      ...(!f.currentVersion ? { cards: productFeatureCards(tasks, project, f.id) } : {}),
      counts, eta: f.currentVersion ? featureEta(nodes, pace, active, events, now) : null,
      lastActivityAt: cards.length ? Math.max(...cards.map((t) => t.updatedAt)) : null };
  });
  const deps = featureDeps(db, project).map(({ from, to, note }) => ({ from, to, note }));
  propagateEtas(features, deps);
  return { throughput: { verified12h: pace.verified12h, perHour: pace.perHour }, features, deps };
}
