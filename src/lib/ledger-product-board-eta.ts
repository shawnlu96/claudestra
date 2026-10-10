import type { DagNode } from "./ledger-feature.js";
import { nodePhase } from "./ledger-dag-rules.js";
import { stageTimeline } from "./ledger-metrics.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";

export const HOUR = 3_600_000;
export const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length ? s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 : 4;
};

export function estimateHours(text: string): number | null {
  const s = text.trim();
  if (s === "S") return 1;
  if (s === "半天") return 4;
  const m = s.match(/^(?:设计稿\s*)?(\d+(?:\.\d+)?)\s*(?:[–-]\s*(\d+(?:\.\d+)?)\s*)?(天|小时|分钟)$/);
  if (!m) return null;
  const n = Number(m[2] ?? m[1]) * (m[3] === "天" ? 8 : m[3] === "分钟" ? 1 / 60 : 1);
  return n > 0 && Number.isFinite(n) ? n : null;
}
export const deferredNode = (n: Pick<DagNode, "oneLine">): boolean => /^\s*(?:（远期）|\(远期\))/.test(n.oneLine);
/** accepted：没绑卡的 PAGEOK 凭项目整页验收源按已完成算（lib/ui-page-display.ts） */
export interface EtaNode extends DagNode { task: LedgerTask | null; accepted?: boolean }
export const phase = (n: EtaNode) => (n.accepted ? "done" : nodePhase(n.taskId, n.task?.stage ?? null));
interface EtaBasis { perHour: number; samples: number; k: number; cpHours: number; remaining: number; share: number }
export interface ProductEta { at: number | null; done: boolean; basis: EtaBasis }
export interface Pace { verified12h: number; perHour: number; samples: number; k: number; fallback: number }

/** First entries avoid counting repeated verification and later regressions as fresh throughput. */
function completionAt(task: LedgerTask, events: readonly LedgerEvent[], now: number): number | null {
  const timeline = stageTimeline(events, now);
  const stage = task.kind === "investigate" ? "done" : "verified";
  return timeline.find((e) => e.stage === stage)?.from ?? timeline.find((e) => e.stage === "done" || e.stage === "cancelled")?.from ?? null;
}

export function projectPace(nodes: readonly EtaNode[], tasks: readonly LedgerTask[], events: ReadonlyMap<string, readonly LedgerEvent[]>, now: number): Pace {
  const estimates = nodes.filter((n) => !deferredNode(n)).map((n) => estimateHours(n.estimate)).filter((x): x is number => x !== null);
  const fallback = median(estimates), ratios: number[] = [];
  let verified12h = 0;
  for (const t of tasks) {
    const line = stageTimeline(events.get(t.id) ?? [], now);
    const finish = line.find((e) => e.stage === (t.kind === "investigate" ? "done" : "verified"))?.from;
    if (finish !== undefined && finish <= now && finish >= now - 12 * HOUR) verified12h++;
  }
  const seen = new Set<string>();
  for (const n of nodes) {
    if (!n.task || deferredNode(n) || seen.has(n.task.id)) continue;
    seen.add(n.task.id);
    const line = stageTimeline(events.get(n.task.id) ?? [], now);
    const build = line.find((e) => e.stage === "build")?.from, verified = line.find((e) => e.stage === "verified")?.from;
    if (build === undefined || verified === undefined || verified < build || verified > now || verified < now - 24 * HOUR) continue;
    ratios.push((verified - build) / HOUR / (estimateHours(n.estimate) ?? fallback));
  }
  return { verified12h, perHour: Math.max(0.25, verified12h / 12), samples: ratios.length,
    k: ratios.length < 3 ? 1 : Math.min(4, Math.max(0.25, median(ratios))), fallback };
}

/** Completed predecessors contribute zero hours; deferred work contributes neither time nor remaining count. */
export function criticalPath(nodes: readonly EtaNode[], fallback: number): number {
  const byKey = new Map(nodes.map((n) => [n.key, n])), memo = new Map<string, number>(), visiting = new Set<string>();
  const length = (key: string): number => {
    if (memo.has(key)) return memo.get(key)!;
    if (visiting.has(key)) throw new Error(`DAG cycle at ${key}`);
    const n = byKey.get(key);
    if (!n || deferredNode(n) || phase(n) === "done") return 0;
    visiting.add(key);
    const weight = (estimateHours(n.estimate) ?? fallback) * (phase(n) === "active" ? 0.5 : 1);
    const hours = weight + Math.max(0, ...n.deps.map(length));
    visiting.delete(key); memo.set(key, hours);
    return hours;
  };
  return Math.max(0, ...nodes.map((n) => length(n.key)));
}

export function featureEta(nodes: readonly EtaNode[], pace: Pace, projectActive: number, events: ReadonlyMap<string, readonly LedgerEvent[]>, now: number): ProductEta {
  const included = nodes.filter((n) => !deferredNode(n));
  const remaining = included.filter((n) => phase(n) !== "done").length;
  const share = Math.max(1, included.filter((n) => phase(n) === "active").length) / Math.max(1, projectActive);
  const cpHours = criticalPath(nodes, pace.fallback);
  const basis = { perHour: pace.perHour, samples: pace.samples, k: pace.k, cpHours, remaining, share };
  if (!remaining) {
    const ends = included.flatMap((n) => n.task ? [completionAt(n.task, events.get(n.task.id) ?? [], now)].filter((t): t is number => t !== null) : []);
    return { at: ends.length ? Math.max(...ends) : null, done: true, basis };
  }
  return { at: now + Math.max(cpHours * pace.k, remaining / (pace.perHour * share)) * HOUR, done: false, basis };
}

/** Topological traversal lets a whole prerequisite chain propagate regardless of response ordering. */
export function propagateEtas<T extends { id: string; eta: ProductEta | null }>(features: T[], deps: readonly { from: string; to: string }[]): void {
  const byId = new Map(features.map((f) => [f.id, f])), visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`feature cycle at ${id}`);
    visiting.add(id);
    const f = byId.get(id);
    for (const d of deps.filter((d) => d.to === id)) {
      visit(d.from);
      const at = byId.get(d.from)?.eta?.at;
      if (f?.eta && at != null) f.eta.at = Math.max(f.eta.at ?? at, at);
    }
    visiting.delete(id); visited.add(id);
  };
  for (const f of features) visit(f.id);
}
