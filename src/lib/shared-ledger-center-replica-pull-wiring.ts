/**
 * REPLPULL1 wiring: the bridge (src/bridge/ask-entry.ts, the line after initCenterProposalInbox) calls initCenterReplicaPull
 * once. First round about a minute later (not together with the inbox poll), then every 5 minutes; timers unref'd. One round
 * at a time: a tick while the last round still runs is skipped. Every round is caught whole (one line, error name only).
 * The recovery policy is read per project each round (switching modes needs no restart); the writable ledger is opened only
 * by a round that actually syncs (off never opens it, never calls the center).
 */
import { openLedger } from "./ledger-store.js";
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
  startCenterReplicaPull({ db: () => openLedger(), policy: recoveryPolicy, log: (line) => console.log(line), seen: new Set() },
    { setTimeout: (fn, ms) => setTimeout(fn, ms), setInterval: (fn, ms) => setInterval(fn, ms) });
}
