/**
 * One round of the scheduler daemon (src/scheduler.ts) once scheduler.json and lend.json are read: open the ledger, run the
 * pass, raise its failures. Nothing here reads a project view per round: the pass reads what it needs itself (SCHEDMEM1).
 * tests/scheduler-daemon-pass.test.ts.
 */
import type { LedgerReader } from "./ledger-read.js";
import { lendStep } from "./lend-deps.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import type { PassOpts } from "./scheduler-pass.js";
import { schedulerV2Pass } from "./scheduler-v2-wiring-pass.js";

export interface DaemonPassDeps { pass: typeof schedulerV2Pass; lend: typeof lendStep }

/** Either switch on runs the pass: scheduler.json for merge / watch / auto dispatch, lend (lend.json or orders still running) for the lend step. */
export async function schedulerDaemonPass(reader: LedgerReader, config: SchedulerConfig, lend: boolean, opts: Omit<PassOpts, "lend">,
  deps: DaemonPassDeps = { pass: schedulerV2Pass, lend: lendStep }): Promise<void> {
  if (!config.enabled && !lend) return;
  const db = reader.get();
  if (config.enabled && !db) throw new Error("scheduler enabled but ledger is unavailable");
  const { failed } = await deps.pass(db, config, { ...opts, ...(lend ? { lend: deps.lend(reader) } : {}) });
  if (failed.length) throw new Error(`tick failed: ${failed.map((f) => `${f.taskId} ${f.error}`).join("; ").slice(0, 500)}`);
}
