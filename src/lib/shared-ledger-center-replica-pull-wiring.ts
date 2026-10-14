/**
 * REPLPULL1 wiring: the bridge (src/bridge/ask-entry.ts, the line after initCenterProposalInbox) calls initCenterReplicaPull
 * once. First round about a minute later (not together with the inbox poll), then every 5 minutes; timers unref'd. One round
 * at a time: a tick while the last round still runs is skipped. Every round is caught whole (one line, error name only).
 * The recovery policy is read per project each round (switching modes needs no restart); the writable ledger is opened only
 * by an `on` round; observe opens a read-only connection to an existing ledger file (no create, no migration) and closes it;
 * off opens neither and never calls the center.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { LEDGER_PATH, openLedger } from "./ledger-store.js";
import { recoveryPolicy } from "./recovery-policy.js";
import { CENTER_REPLICA_PULL_INTERVAL_MS, runCenterReplicaPull, type CenterReplicaPullDeps } from "./shared-ledger-center-replica-pull.js";

export const CENTER_REPLICA_PULL_FIRST_DELAY_MS = 60_000;
type Timer = { unref?: () => unknown };
export interface CenterReplicaPullTimers {
  setTimeout: (fn: () => void, ms: number) => Timer;
  setInterval: (fn: () => void, ms: number) => Timer;
}

/** Arms the first round and the interval; `tick` is what each timer fires (resolves when that round, or its skip, is done). */
export function startCenterReplicaPull(deps: CenterReplicaPullDeps, timers: CenterReplicaPullTimers) {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try { await runCenterReplicaPull(deps); }
    catch (e) { deps.log(`[center-replica-pull] 本轮失败: ${e instanceof Error ? e.name : "Error"}`); }
    finally { running = false; }
  };
  const fire = () => void tick();
  timers.setTimeout(() => { fire(); timers.setInterval(fire, CENTER_REPLICA_PULL_INTERVAL_MS).unref?.(); }, CENTER_REPLICA_PULL_FIRST_DELAY_MS).unref?.();
  return { tick };
}

let started = false;
export function initCenterReplicaPull(): void {
  if (started) return;
  started = true;
  startCenterReplicaPull({ db: () => openLedger(), readDb: openLedgerReadOnly, policy: recoveryPolicy, log: (line) => console.log(line), seen: new Set() },
    { setTimeout: (fn, ms) => setTimeout(fn, ms), setInterval: (fn, ms) => setInterval(fn, ms) });
}

/** Observe's ledger: read only, never created (a missing file is this round's error, like the mirror loop's read connection). */
export function openLedgerReadOnly(path: string = LEDGER_PATH): Database {
  if (!existsSync(path)) throw new Error("ledger missing");
  const db = new Database(path, { readonly: true });
  db.run("PRAGMA busy_timeout = 2000");
  return db;
}
