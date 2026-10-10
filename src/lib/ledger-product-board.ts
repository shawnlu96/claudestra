import type { Database } from "bun:sqlite";
import { hasFeatureSchema } from "./ledger-dag-board.js";
import { effectiveNodes, getDagVersion, type Feature } from "./ledger-feature.js";
import { featureDeps } from "./ledger-feature-deps.js";
import { deferredNode, featureEta, phase, projectPace, propagateEtas, type EtaNode } from "./ledger-product-board-eta.js";
import { nodePhase } from "./ledger-dag-rules.js";
import { listEvents, listTasks } from "./ledger-store.js";
import { productFeatureCards } from "./ledger-product-board-cards.js";
import { deferredLine, productNodeCounts } from "./product-node-counts.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { isSourceAcceptedNode, pageAcceptedBySource } from "./ui-page-display.js";

export function nodeCounts(nodes: readonly EtaNode[]) {
  // 凭项目验收源完成的 PAGEOK 没有卡：按完成卡的样子喂计数（product-node-counts 是网页 twin，不改）
  return productNodeCounts(nodes.map((n) => ({ key: n.key, deferred: deferredLine(n.oneLine), deps: n.deps,
    ...(n.accepted ? { taskId: n.key, stage: "done" } : { taskId: n.taskId, stage: n.task?.stage ?? null }) })));
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
    const accepted = !!v && pageAcceptedBySource(db, f, v.version);
    const nodes: EtaNode[] = v ? effectiveNodes(db, v).map((n) => ({ ...n, task: n.taskId ? own.get(n.taskId) ?? null : null,
      ...(accepted && isSourceAcceptedNode(n) ? { accepted: true } : {}) })) : [];
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
