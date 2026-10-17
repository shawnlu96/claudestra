/**
 * WEBQUOTA1 · recovery key `webStorageBudget` (default on via recovery-key-defaults.ts): the bridge only hands the mode to
 * browsers (GET /settings, read-only) and records their observe samples. The budget / coalescing logic itself lives in
 * web/lib/floka-storage/sync-budget.ts. Rollback: `ledger scheduler-recovery claude-orchestrator off --key webStorageBudget
 * --reason ...`; browsers pick it up on their next settings read, no restart. Independent of `rename.webStorage`.
 */
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { LEDGER_PATH, openLedger } from "./ledger-store.js";
import { recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";

const PROJECT = "claude-orchestrator";
const WEB_STORAGE_BUDGET_KEY = "webStorageBudget";
/** sync-budget.ts BudgetSample: `<area>:<action>:<rev>` plus a key name or area; values never leave the browser. */
const ACTION_KEY = /^(?:localStorage|indexedDB):[a-z-]{1,40}:r\d{1,3}$/;
const TARGET = /^[\w.:@-]{1,60}$/;

export function webStorageBudgetMode(policy: RecoveryPolicyPort = recoveryPolicy): RecoveryMode {
  return policy(PROJECT, WEB_STORAGE_BUDGET_KEY).mode;
}

export type SampleOutcome = { ok: true; recorded: boolean } | { ok: false; status: 400 | 409 | 503; error: string };
/**
 * One ledger note per target + action + rule revision (recordObserved dedups across tabs and browsers). The mode is re-read
 * here: a browser still holding a stale observe after a switch records nothing.
 */
export function recordWebStorageSample(body: unknown, deps: { db: () => Database | null; policy?: RecoveryPolicyPort; now?: number } = { db: defaultDb }): SampleOutcome {
  const b = (body ?? {}) as { target?: unknown; actionKey?: unknown };
  if (typeof b.target !== "string" || !TARGET.test(b.target) || typeof b.actionKey !== "string" || !ACTION_KEY.test(b.actionKey)) {
    return { ok: false, status: 400, error: "sample needs target (key name) and actionKey (<area>:<action>:r<n>)" };
  }
  if (webStorageBudgetMode(deps.policy) !== "observe") return { ok: false, status: 409, error: "webStorageBudget is not in observe" };
  const db = deps.db();
  if (!db) return { ok: false, status: 503, error: "ledger unavailable" };
  const { recorded } = recordObserved(db, {
    project: PROJECT, mechanism: WEB_STORAGE_BUDGET_KEY, target: "", actionKey: `${b.actionKey}/${b.target}`,
    action: `浏览器存储 ${b.actionKey}（${b.target}）`,
  }, deps.now ?? Date.now());
  return { ok: true, recorded };
}

/** Never create a ledger just to hold a sample. */
function defaultDb(): Database | null {
  return existsSync(LEDGER_PATH) ? openLedger() : null;
}
