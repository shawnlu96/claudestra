/** Request reduction is opt-in; observation counts never append ledger events (which would themselves trigger uploads). */
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./paths.js";
import { readRecoveryFile, type RecoveryMode } from "./recovery-policy.js";
import { acquireLock } from "./file-lock.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import type { Stage2Wiring } from "./shared-ledger-v2-wiring.js";

export function centerRequestBudgetMode(project: string, dir = STATE_DIR): RecoveryMode {
  const file = readRecoveryFile(join(dir, "recovery-policy.json"));
  if (file.status === "corrupt") return "off";
  if (file.status !== "ok") return "observe";
  return file.data.projects[project]?.keys?.centerRequestBudget ?? "observe";
}
const counts = new Map<string, number>();
let summaryTimer: ReturnType<typeof setTimeout> | undefined;
export function budgetWouldSkip(mode: RecoveryMode, reason: "projection-idle" | "lend-local" | "lend-forbidden" | "lend-backoff"): boolean {
  if (mode === "observe") {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
    summaryTimer ??= setTimeout(() => {
      console.info(`[centerRequestBudget] 本会跳过 ${JSON.stringify(Object.fromEntries(counts))}`);
      counts.clear(); summaryTimer = undefined;
    }, 10 * 60_000);
    summaryTimer.unref();
  }
  return mode === "on";
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
/** Only hashes leave memory; rotating credentials or changing bindings invalidates both the pause and cached transports. */
export function lendBudgetVersion(wiring: Stage2Wiring, project: string, binding: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify([project, binding, wiring.scope(project)]));
  for (const name of ["shared-ledger-credentials.json", "shared-ledger-bindings.json", "instance-key.pem"]) {
    try { hash.update(readFileSync(join(wiring.dir, name))); }
    catch { hash.update(`missing:${name}`); } // No secret in diagnostics; an absent/unreadable credential cannot make a valid request.
  }
  return hash.digest("hex");
}
interface Pause { version: string; forbidden: boolean; failures: number; until: number }
function pausePath(dir: string, orderId: string, version: string): string { return join(dir, "center-request-budget", `${digest(`${orderId}\0${version}`)}.json`); }
function readPause(dir: string, orderId: string, version: string): Pause {
  const state = readJsonStateSync(pausePath(dir, orderId, version), (v) => !!v && typeof v === "object"
    && typeof (v as Pause).version === "string" && typeof (v as Pause).forbidden === "boolean"
    && Number.isSafeInteger((v as Pause).failures) && (v as Pause).failures >= 0 && Number.isFinite((v as Pause).until));
  return state.status === "ok" && (state.data as Pause).version === version ? state.data as Pause
    : { version, forbidden: false, failures: 0, until: 0 };
}
export function lendBudgetPaused(dir = STATE_DIR, orderId: string, version: string, mode: RecoveryMode, now = Date.now()): boolean {
  const pause = readPause(dir, orderId, version);
  return (pause.forbidden || pause.until > now) && budgetWouldSkip(mode, pause.forbidden ? "lend-forbidden" : "lend-backoff");
}
export async function settleLendBudget(dir = STATE_DIR, orderId: string, version: string, error: unknown, now = Date.now()): Promise<void> {
  const status = (error as { status?: number } | null)?.status, code = (error as { code?: string } | null)?.code;
  if (error && status !== 403 && status !== 429 && status !== undefined && status < 500) return;
  const path = pausePath(dir, orderId, version);
  try {
    mkdirSync(join(dir, "center-request-budget"), { recursive: true, mode: 0o700 });
    const lock = await acquireLock(`${path}.lock`);
    if (!lock) return;
    try {
      const old = readPause(dir, orderId, version), failures = error ? old.failures + 1 : 0;
      const delay = Math.min(300_000, 5_000 * 2 ** Math.min(6, Math.max(0, failures - 1)) * (1 + Math.random() * 0.2));
      const pause: Pause = { version, failures, forbidden: status === 403 || code === "forbidden", until: error ? now + delay : 0 };
      writeJsonAtomicSync(path, pause, { mode: 0o600, commitIf: lock.held });
    } finally { lock.release(); }
  } catch { console.warn("[centerRequestBudget] lend pause not recorded"); } // Preserve the original network error even if local state is unwritable.
}
