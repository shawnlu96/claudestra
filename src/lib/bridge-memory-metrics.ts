/** Numeric-only diagnostics. A trend describes this observation window, never proves a production leak. */
const MEMORY_KEYS = ["rss", "heapUsed", "heapTotal", "external", "arrayBuffers"] as const;
const COUNTER_KEYS = ["emittedEvents", "bufferedEvents", "subscribers", "controlObjects", "controlBytes"] as const;
type MemoryKey = typeof MEMORY_KEYS[number];
type CounterKey = typeof COUNTER_KEYS[number];
export type ProbeMode = "on" | "observe" | "off";
export type MemoryValues = Record<MemoryKey, number | null>;
export type MemoryCounters = Record<CounterKey, number | null>;
export interface MemoryPoint {
  index: number;
  atMs: number;
  elapsedMs: number;
  uptimeSeconds: number | null;
  phase: "baseline" | "warmup" | "measure";
  pid: number;
  identity: string;
  memory: MemoryValues;
  counters: MemoryCounters;
  host: { freeBytes: number | null; load1: number | null; swapUsedBytes: number | null };
}

export function probeMode(value: string | undefined): ProbeMode {
  if (value === undefined) return "observe";
  if (value === "on" || value === "observe" || value === "off") return value;
  throw new Error("invalid_mode");
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function memoryValues(value: Partial<Record<MemoryKey, unknown>> = {}): MemoryValues {
  return Object.fromEntries(MEMORY_KEYS.map((k) => [k, numeric(value[k])])) as MemoryValues;
}

export function memoryCounters(value: Partial<Record<CounterKey, unknown>> = {}): MemoryCounters {
  return Object.fromEntries(COUNTER_KEYS.map((k) => [k, numeric(value[k])])) as MemoryCounters;
}

/** Parse allowlisted fields only: report input may carry arbitrary text, which must never be echoed. */
export function parseMemoryPoint(input: unknown): MemoryPoint {
  if (!input || typeof input !== "object") throw new Error("invalid_point");
  const p = input as MemoryPoint;
  if (![p.index, p.atMs, p.elapsedMs].every((v) => numeric(v) !== null)
    || !Number.isSafeInteger(p.pid) || p.pid < 1 || !Number.isSafeInteger(p.index)
    || typeof p.identity !== "string" || !/^[a-f0-9]{64}$/.test(p.identity)
    || !["baseline", "warmup", "measure"].includes(p.phase) || !p.memory || !p.counters || !p.host) throw new Error("invalid_point");
  return {
    index: p.index, atMs: p.atMs, elapsedMs: p.elapsedMs, uptimeSeconds: numeric(p.uptimeSeconds),
    phase: p.phase, pid: p.pid, identity: p.identity,
    memory: memoryValues(p.memory), counters: memoryCounters(p.counters),
    host: { freeBytes: numeric(p.host.freeBytes), load1: numeric(p.host.load1), swapUsedBytes: numeric(p.host.swapUsedBytes) },
  };
}

export interface MemoryTrend {
  kind: "unknown" | "plateau" | "sustained_growth" | "variable";
  delta: number | null;
  perSecond: number | null;
}

/** Require six post-warmup points and growth in both halves; two RSS readings cannot establish a trend. */
function trend(points: MemoryPoint[], get: (p: MemoryPoint) => number | null, floor: number): MemoryTrend {
  const unknown: MemoryTrend = { kind: "unknown", delta: null, perSecond: null };
  if (points.length < 6) return unknown;
  const values = points.map(get);
  if (values.some((v) => v === null)) return unknown;
  const v = values as number[];
  const duration = (points.at(-1)!.elapsedMs - points[0].elapsedMs) / 1000;
  if (duration <= 0) return unknown;
  const delta = v.at(-1)! - v[0];
  const tolerance = Math.max(floor, v[0] * 0.02);
  const half = Math.floor(v.length / 2);
  const rises = v.slice(1).filter((n, i) => n > v[i]).length;
  const third = Math.ceil(v.length / 3);
  const headTotal = v.slice(0, third).reduce((sum, n) => sum + n, 0);
  const tailTotal = v.slice(-third).reduce((sum, n) => sum + n, 0);
  const rising = delta > 0 || tailTotal > headTotal;
  const growth = delta > tolerance && v[half - 1] - v[0] > tolerance / 4
    && v.at(-1)! - v[half] > tolerance / 4 && rises >= Math.ceil((v.length - 1) * 0.75);
  // GC dips can hide growth inside the amplitude tolerance. A net gain or elevated tail prevents a plateau verdict.
  const kind = growth ? "sustained_growth" : rising ? "unknown"
    : Math.max(...v) - Math.min(...v) <= tolerance ? "plateau" : "variable";
  return { kind, delta, perSecond: delta / duration };
}

export function analyzeMemory(points: MemoryPoint[]) {
  const phaseOrder = { baseline: 0, warmup: 1, measure: 2 };
  const valid = points.length > 0 && points[0].index === 0 && points[0].phase === "baseline"
    && points.every((p, i) => p.pid === points[0].pid && p.identity === points[0].identity
    && (i === 0 || (p.index === points[i - 1].index + 1 && p.elapsedMs > points[i - 1].elapsedMs
      && p.phase !== "baseline" && phaseOrder[p.phase] >= phaseOrder[points[i - 1].phase]
      && p.atMs >= points[i - 1].atMs && (p.uptimeSeconds === null || points[i - 1].uptimeSeconds === null
        || p.uptimeSeconds >= points[i - 1].uptimeSeconds!))));
  const measured = valid ? points.filter((p) => p.phase === "measure") : [];
  const memory = Object.fromEntries(MEMORY_KEYS.map((k) => [k, trend(measured, (p) => p.memory[k], 1024 * 1024)])) as Record<MemoryKey, MemoryTrend>;
  const counters = Object.fromEntries(COUNTER_KEYS.map((k) => [k, trend(measured, (p) => p.counters[k], 0)])) as Record<CounterKey, MemoryTrend>;
  const retainedGrowth = ["bufferedEvents", "controlObjects", "controlBytes"].some((k) => counters[k as CounterKey].kind === "sustained_growth");
  const heapGrowth = ["heapUsed", "external", "arrayBuffers"].some((k) => memory[k as MemoryKey].kind === "sustained_growth");
  const known = MEMORY_KEYS.filter((k) => memory[k].kind !== "unknown");
  const unresolvedGrowth = MEMORY_KEYS.some((k) => memory[k].kind === "unknown" && memory[k].delta !== null);
  const classification = !valid || measured.length < 6 ? "unknown"
    : retainedGrowth && heapGrowth ? "retention_growth_observed"
    : retainedGrowth ? "retained_counts_growing"
    : heapGrowth ? "heap_growth_unattributed"
    : memory.rss.kind === "sustained_growth" ? "rss_growth_unattributed"
    : unresolvedGrowth || !known.length ? "unknown"
    : known.length && known.every((k) => memory[k].kind === "plateau") ? "plateau_observed"
    : "inconclusive";
  return {
    classification, identityConsistent: valid, measuredPoints: measured.length,
    windowMs: measured.length ? measured.at(-1)!.elapsedMs - measured[0].elapsedMs : 0,
    baseline: points.find((p) => p.phase === "baseline")?.memory ?? null,
    memory, counters, leakProven: false,
    limitations: ["window_only", "external_process_influence_unmeasured", "allocator_and_gc_may_affect_rss",
      ...(unresolvedGrowth ? ["sub_tolerance_growth_requires_longer_window"] : []),
      ...(points.some((p) => p.host.swapUsedBytes === null) ? ["swap_unknown"] : []),
      ...(!measured.length || measured.some((p) => MEMORY_KEYS.some((k) => p.memory[k] === null))
        ? ["some_runtime_metrics_unavailable"] : [])],
  };
}
