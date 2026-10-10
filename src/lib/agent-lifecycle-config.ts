/**
 * The card worker lifecycle switch (scheduler.json `lifecycle`, lib/agent-lifecycle.ts): "on" / "observe" / "off" or an object with
 * `mode` plus thresholds. Absent = observe, so a fresh install only reports what it would collect until PM switches it on.
 * Thresholds are minutes / percent; a bad value is a config error (the whole scheduler config refuses), never a silent guess.
 */
type LifecycleMode = "on" | "observe" | "off";

export interface LifecyclePolicy {
  mode: LifecycleMode;
  /** A reviewer whose card left review this long ago (and whose verdict is recorded) is collected. */
  reviewerAfterReviewMin: number;
  /** A reviewer idle this long is collected whatever its card's stage. */
  reviewerIdleMin: number;
  /** An author idle this long on a card in merge / live / blocked is retired (removed with its own disk; a later round resumes or creates a fresh one). */
  authorIdleMin: number;
  /** An unregistered worker-looking agent idle this long on a finished or unknown card is collected (stock backfill). */
  stockIdleMin: number;
  /** System swap use above this percentage starts the memory backstop. */
  swapPct: number;
  /** An agent with a turn this recent is never touched (PM may be using it right now). */
  recentTurnMin: number;
  /** Most agents collected per scheduler pass: each is an archive + remove child and a channel delete. */
  perPass: number;
}

export const DEFAULT_LIFECYCLE: LifecyclePolicy = {
  mode: "observe", reviewerAfterReviewMin: 120, reviewerIdleMin: 360, authorIdleMin: 360, stockIdleMin: 360,
  swapPct: 70, recentTurnMin: 30, perPass: 5,
};

const RANGES: Record<Exclude<keyof LifecyclePolicy, "mode">, [number, number]> = {
  reviewerAfterReviewMin: [5, 10_080], reviewerIdleMin: [30, 10_080], authorIdleMin: [30, 10_080], stockIdleMin: [30, 10_080],
  swapPct: [10, 99], recentTurnMin: [5, 720], perPass: [1, 50],
};

const isMode = (v: unknown): v is LifecycleMode => v === "on" || v === "observe" || v === "off";

export function parseLifecycle(raw: unknown, where = "scheduler.lifecycle"): LifecyclePolicy {
  if (raw === undefined) return { ...DEFAULT_LIFECYCLE };
  if (isMode(raw)) return { ...DEFAULT_LIFECYCLE, mode: raw };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} must be on|observe|off or an object`);
  const r = raw as Record<string, unknown>;
  const mode = r.mode ?? DEFAULT_LIFECYCLE.mode;
  if (!isMode(mode)) throw new Error(`${where}.mode must be on|observe|off`);
  const out: LifecyclePolicy = { ...DEFAULT_LIFECYCLE, mode };
  for (const [key, [lo, hi]] of Object.entries(RANGES) as [keyof typeof RANGES, [number, number]][]) {
    const v = r[key];
    if (v === undefined) continue;
    if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) throw new Error(`${where}.${key} must be an integer ${lo}..${hi}`);
    out[key] = v as number;
  }
  const unknown = Object.keys(r).filter((k) => k !== "mode" && !(k in RANGES));
  if (unknown.length) throw new Error(`${where} has unknown keys: ${unknown.join(", ")}`);
  return out;
}
