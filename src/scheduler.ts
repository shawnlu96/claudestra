/** Fourth launchd daemon. Missing config is an explicit idle state until projects opt in. */
import { readSchedulerConfig } from "./lib/scheduler-config.js";
import { LedgerReader } from "./lib/ledger-read.js";
import { schedulerProjectView } from "./lib/ledger-scheduler.js";
import { schedulerMergeTick } from "./lib/scheduler-service.js";

export async function runScheduler(signal: AbortSignal, wait: (ms: number) => Promise<void> = Bun.sleep): Promise<void> {
  const reader = new LedgerReader();
  let lastError = "";
  while (!signal.aborted) {
    let pollMs = 5000;
    try {
      const config = readSchedulerConfig();
      pollMs = config.pollMs;
      if (config.enabled) {
        const db = reader.get();
        if (!db) throw new Error("scheduler enabled but ledger is unavailable");
        for (const project of Object.keys(config.projects)) schedulerProjectView(db, project);
        await schedulerMergeTick(db, config);
      }
      if (lastError) console.error("scheduler recovered");
      lastError = "";
    } catch (e) {
      const error = (e as Error).message;
      if (error !== lastError) console.error(`scheduler idle: ${error}`);
      lastError = error;
    }
    if (!signal.aborted) await wait(pollMs);
  }
  reader.close();
}

if (import.meta.main) {
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
  await runScheduler(stop.signal);
}
