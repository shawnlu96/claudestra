import type { Database } from "bun:sqlite";
import { hasFeatureSchema } from "./ledger-dag-board.js";
import { effectiveNodes, getDagVersion, type Feature } from "./ledger-feature.js";
import { featureDeps } from "./ledger-feature-deps.js";
import { deferredNode, featureEta, phase, projectPace, propagateEtas, type EtaNode } from "./ledger-product-board-eta.js";
import { nodePhase } from "./ledger-dag-rules.js";
import { listTasks } from "./ledger-store.js";
import { productEvents } from "./ledger-read-fast.js";
import { compactStage } from "./ledger-read-cards.js";
import { productFeatureCards } from "./ledger-product-board-cards.js";
import { productEdges } from "./ledger-product-board-edges.js";
import { productNodeCounts } from "./product-node-counts.js";
import { countRows, productFrontier } from "./ledger-product-board-frontier.js";
import { projectMapConfig } from "./project-map-config.js";
import { isSourceAcceptedNode, pageAcceptedBySource } from "./ui-page-display.js";

export function nodeCounts(nodes: readonly EtaNode[]) {
  return productNodeCounts(countRows(nodes));
}

/** Reads only current effective nodes and project-owned tasks. Caller wraps one deferred transaction. */
export function productBoard(db: Database, project: string, now: number) {
  const map = projectMapConfig(project), grouped = map.areas.length > 0;
  const areaOf = new Map(map.areas.flatMap((a) => a.features.map((id) => [id, a.id] as const)));
  const tasks = listTasks(db, project), own = new Map(tasks.map((t) => [t.id, t]));
  const fs = hasFeatureSchema(db) ? db.query("SELECT * FROM features WHERE project=? ORDER BY id").all(project) as Feature[] : [];
  const entries = fs.map((f) => {
    const v = f.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
    const accepted = !!v && pageAcceptedBySource(db, f, v.version);
    const nodes: EtaNode[] = v ? effectiveNodes(db, v).map((n) => ({ ...n, task: n.taskId ? own.get(n.taskId) ?? null : null,
      ...(accepted && isSourceAcceptedNode(n) ? { accepted: true } : {}) })) : [];
    return { f, nodes };
  });
  // 不逐条读全部历史（ledger-read-fast.ts）：在跑的卡和读不到的节点卡给全部事件，其余只给时间线上要 find 的几条
  const full = [...tasks.filter((t) => !compactStage(t.stage)).map((t) => t.id), ...entries.flatMap((e) => e.nodes.flatMap((n) => n.taskId && !n.task ? [n.taskId] : []))];
  const events = productEvents(db, project, [...new Set(full)], tasks.filter((t) => compactStage(t.stage)).map((t) => t.id));
  const all = entries.flatMap((e) => e.nodes), pace = projectPace(all, tasks, events, now);
  const active = all.filter((n) => !deferredNode(n) && phase(n) === "active").length;
  const features = entries.map(({ f, nodes }) => {
    const cards = f.currentVersion ? nodes.flatMap((n) => n.task ? [n.task] : []) : tasks.filter((t) => t.featureId === f.id);
    const counts = f.currentVersion ? nodeCounts(nodes) : { total: cards.length,
      completed: cards.filter((t) => nodePhase(t.id, t.stage) === "done").length,
      active: cards.filter((t) => nodePhase(t.id, t.stage) === "active").length, waiting: 0 };
    return { id: f.id, title: f.title, status: f.status, hasDag: f.currentVersion > 0, version: f.currentVersion,
      ...(!f.currentVersion ? { cards: productFeatureCards(tasks, project, f.id) } : {}), ...(grouped ? { area: areaOf.get(f.id) ?? null } : {}),
      counts, eta: f.currentVersion ? featureEta(nodes, pace, active, events, now) : null,
      lastActivityAt: cards.length ? Math.max(...cards.map((t) => t.updatedAt)) : null,
      ...productFrontier({ status: f.status, nodes: f.currentVersion ? nodes : null, cards, events, now, frozen: map.frozen }) };
  });
  const deps = featureDeps(db, project).map(({ from, to, note }) => ({ from, to, note }));
  propagateEtas(features, deps);
  return { throughput: { verified12h: pace.verified12h, perHour: pace.perHour }, features,
    ...(grouped ? { areas: map.areas.map(({ id, name }) => ({ id, name })) } : {}), ...productEdges(db, { project, deps, features, tasks, entries }) };
}
