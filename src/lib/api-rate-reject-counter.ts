import { randomUUID } from "node:crypto";
import { recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";

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
}
export interface ApiRejectCounterOptions {
  policy?: RecoveryPolicyPort;
  observe?: (sample: RejectCounterObservation) => void;
}

/**
 * Only diagnostics switch representation. Crossing on/non-on starts a fresh reject history; accepted hits and log
 * throttling live in ApiRateBucket and are never reset. off/observe share the original exact history unchanged.
 * Samples deduplicate per bucket lifetime and algorithm version; random targets contain no credential/route identity.
 */
export class ApiRejectCounter {
  private bounded: SecondRejectCounter | undefined;
  private legacy: number[] | undefined;
  private observed = false;
  constructor(private options: ApiRejectCounterOptions = {}) {}

  private mode(): RecoveryMode {
    try {
      const p = (this.options.policy ?? recoveryPolicy)("claude-orchestrator", KEY);
      return p.source === "error" ? "off" : p.mode;
    } catch { return "off"; } // A failed reader restores legacy diagnostics; quota decisions never depend on it.
  }

  update(now: number, rejected = false): number {
    // Read immediately before changing diagnostics, including attempts()/used() and live rollback without restart.
    const mode = this.mode();
    if (mode === "on") {
      this.legacy = undefined;
      this.bounded ??= new SecondRejectCounter();
      return this.bounded.update(now, rejected);
    }
    this.bounded = undefined;
    const history = this.legacy ??= [];
    while (history.length > 0 && history[0]! <= now - WINDOW_MS) history.shift();
    if (rejected) history.push(now);
    if (mode === "observe" && rejected && !this.observed) this.observe();
    return history.length;
  }

  private observe(): void {
    this.observed = true;
    const sample: RejectCounterObservation = { op: "recovery_observe", mechanism: KEY, target: randomUUID(), version: VERSION,
      action: "would replace per-request reject history with 60 one-second cells; rejects expire <1s early; quota unchanged" };
    try { (this.options.observe ?? ((s) => console.info(`[apiRejectCounter] ${JSON.stringify(s)}`)))(sample); }
    catch { /* Diagnostic output failure cannot turn a 429 into an exception or alter accepted quota. */ }
  }
}
