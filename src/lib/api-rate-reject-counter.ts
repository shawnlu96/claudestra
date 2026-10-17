import { createHash } from "node:crypto";
import { openLedger } from "./ledger-store.js";
import { recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";

const SECONDS = 60;
const WINDOW_MS = SECONDS * 1_000;
const KEY = "apiRejectCounter";
const VERSION = "seconds-v1";

/**
 * Current second plus the previous 59 seconds: rejects can expire <1s early, never late. This is a diagnostic,
 * not an exact sliding window. All operations inspect at most 60 cells, even after a huge jump.
 * A clock rollback (including within a second) discards diagnostics so future counts cannot reappear later.
 */
export class SecondRejectCounter {
  private cells = Array.from({ length: SECONDS }, () => ({ second: Number.NEGATIVE_INFINITY, count: 0 }));
  private lastNow = Number.NEGATIVE_INFINITY;

  update(now: number, rejected = false): number {
    const second = Math.floor(now / 1_000);
    const reset = !Number.isFinite(now) || now < this.lastNow;
    this.lastNow = Number.isFinite(now) ? now : Number.NEGATIVE_INFINITY;
    let total = 0;
    for (const cell of this.cells) {
      if (reset || cell.second <= second - SECONDS || cell.second > second) {
        cell.second = Number.NEGATIVE_INFINITY;
        cell.count = 0;
      }
      total += cell.count;
    }
    if (rejected && Number.isFinite(now)) {
      const cell = this.cells[((second % SECONDS) + SECONDS) % SECONDS]!;
      if (cell.second !== second) { cell.second = second; cell.count = 0; }
      cell.count = Math.min(Number.MAX_SAFE_INTEGER, cell.count + 1);
      total = Math.min(Number.MAX_SAFE_INTEGER, total + 1);
    }
    return Math.min(Number.MAX_SAFE_INTEGER, total);
  }
}

export interface RejectCounterObservation {
  op: "recovery_observe";
  mechanism: "apiRejectCounter";
  target: string;
  version: string;
  action: string;
  legacyCount: number;
  boundedCount: number;
  delta: number;
}
export interface ApiRejectCounterOptions {
  policy?: RecoveryPolicyPort;
  /** Monotonic milliseconds, independent of request timestamps; injectable for cache-boundary tests. */
  policyClock?: () => number;
  observe?: (sample: RejectCounterObservation) => void;
  /** Stable bucket identity, hashed before recording; never a credential or request body. */
  target?: string;
}

const cachedReaders = new WeakSet<RecoveryPolicyPort>();

/** One file read per limiter per second, checked before reject/attempts actions; live switches take <=1s of traffic.
 * Reuse the limiter's reader without another cache layer, so a late-created bucket cannot extend that deadline.
 * Failed reads cache off too; accepted/used requests never call this reader. Wall-clock jumps cannot prolong the TTL.
 */
export function cachedRejectPolicy(options: ApiRejectCounterOptions = {}): RecoveryPolicyPort {
  const source = options.policy ?? recoveryPolicy;
  if (cachedReaders.has(source)) return source;
  const clock = options.policyClock ?? (() => performance.now());
  let cached: RecoveryPolicy | undefined, readAt = Number.NEGATIVE_INFINITY;
  const reader: RecoveryPolicyPort = () => {
    const now = clock();
    if (cached && now >= readAt && now - readAt < 1_000) return cached;
    try { cached = source("claude-orchestrator", KEY); }
    catch { cached = { mode: "off", source: "error", manualAfterMs: null }; } // Diagnostic fallback never changes accepted quota.
    readAt = now;
    return cached;
  };
  cachedReaders.add(reader);
  return reader;
}

/**
 * Only diagnostics switch representation. Crossing on/non-on starts a fresh reject history; accepted hits and log
 * throttling live in ApiRateBucket and are never reset. off/observe share the original exact history unchanged.
 * Samples use a hashed bucket identity and algorithm version; the ledger deduplicates across recreation and restart.
 */
export class ApiRejectCounter {
  private bounded: SecondRejectCounter | undefined;
  private legacy: number[] | undefined;
  private shadow: SecondRejectCounter | undefined;
  private observed = false;
  private target: string;
  private readPolicy: RecoveryPolicyPort;
  constructor(private options: ApiRejectCounterOptions = {}) {
    this.target = `bucket:${createHash("sha256").update(options.target ?? "standalone").digest("hex")}`;
    this.readPolicy = cachedRejectPolicy(options);
  }

  private mode(): RecoveryMode {
    try {
      const p = this.readPolicy("claude-orchestrator", KEY);
      return p.source === "error" ? "off" : p.mode;
    } catch { return "off"; } // A failed reader restores legacy diagnostics; quota decisions never depend on it.
  }

  /** Accepted/used paths only expire existing diagnostics; they never read configuration or emit samples. */
  prune(now: number): void {
    this.bounded?.update(now);
    this.shadow?.update(now);
    if (this.legacy) this.pruneLegacy(now);
  }

  private pruneLegacy(now: number): number[] {
    const history = this.legacy ??= [];
    while (history.length > 0 && history[0]! <= now - WINDOW_MS) history.shift();
    return history;
  }

  update(now: number, rejected = false): number {
    // Read before recording/querying rejects; accepted hits and used() only prune the existing representation.
    const mode = this.mode();
    if (mode === "on") {
      this.legacy = undefined;
      this.shadow = undefined;
      this.bounded ??= new SecondRejectCounter();
      return this.bounded.update(now, rejected);
    }
    this.bounded = undefined;
    const history = this.pruneLegacy(now);
    if (rejected) history.push(now);
    const boundedCount = (this.shadow ??= new SecondRejectCounter()).update(now, rejected);
    if (mode === "observe" && rejected && !this.observed) this.observe(now, history.length, boundedCount);
    return history.length;
  }

  private observe(now: number, legacyCount: number, boundedCount: number): void {
    this.observed = true;
    const sample: RejectCounterObservation = { op: "recovery_observe", mechanism: KEY, target: this.target, version: VERSION,
      action: "replace per-request reject history with 60 one-second cells; rejects expire <1s early; quota unchanged",
      legacyCount, boundedCount, delta: boundedCount - legacyCount };
    try {
      if (this.options.observe) this.options.observe(sample);
      // Ledger targets must be tasks/items; bucket identity belongs in the project note's dedup key and safe data.
      else recordObserved(openLedger(), { project: "claude-orchestrator", mechanism: KEY, target: "",
        actionKey: `${VERSION}:${sample.target}`, action: sample.action,
        data: { target: sample.target, version: VERSION, legacyCount, boundedCount, delta: sample.delta } }, now);
    }
    catch { /* Diagnostic output failure cannot turn a 429 into an exception or alter accepted quota. */ }
  }
}
