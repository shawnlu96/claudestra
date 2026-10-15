import type { Database } from "bun:sqlite";
import type { Feature } from "./ledger-feature.js";
import { schedulerV2SkipFeature } from "./scheduler-v2-skip-card.js";
import { featureLanes } from "./dag-tools-lanes.js";
import { readPriorityModes } from "./ledger-priority-read.js";
import { getEventByDedup } from "./ledger-store.js";
import { priorityNowNode } from "./scheduler-priority-now.js";
import { currentViews, featureGate, isStop, nodeCandidate, type ServiceFacts, type SpecFile } from "./scheduler-autostart.js";

/** Read and write paths derive the same dedup key; the writer repeats all gates under its transaction. */
export function priorityNowObservations(db: Database, f: Feature, svc: ServiceFacts, read: (id: string) => SpecFile | null, now: number, keys?: string[]) {
  const m = readPriorityModes(db, f.project).priorityNowStart;
  if (schedulerV2SkipFeature(db, f.id) || m.mode === "off") return [];
  const views = currentViews(db, f);
  const nodes = views.filter((n) => !n.taskId && (!keys || keys.includes(n.key)) && priorityNowNode(db, f, n.key));
  if (!nodes.length) return [];
  const lanes = featureLanes(db, f);
  return nodes.map((n) => {
    const r = featureGate(db, f, svc, n.key, m.mode === "observe")
      ?? nodeCandidate(db, f, n.key, lanes, views, read, now);
    const gate = isStop(r) ? r.gate : null, why = isStop(r) ? r.why : "依赖及所有资格已满足，下一次正常 tick 开工";
    const dedupKey = `priority-now:${f.project}:${f.id}:${n.key}:${m.rev}:${JSON.stringify([gate, why])}`;
    const label = m.mode === "observe" ? gate ? "本会等待" : "本会开工" : "now 等待";
    return { key: n.key, gate, why, dedupKey, mode: m.mode, label };
  });
}

export function pendingPriorityNowKeys(db: Database, f: Feature, svc: ServiceFacts, read: (id: string) => SpecFile | null, now: number): string[] {
  return priorityNowObservations(db, f, svc, read, now).filter((o) => !getEventByDedup(db, o.dedupKey)).map((o) => o.key);
}

