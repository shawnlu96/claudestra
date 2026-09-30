/** Fourth launchd daemon. Missing config is an explicit idle state until projects opt in. */
import { readSchedulerConfig } from "./lib/scheduler-config.js";
import { LedgerReader } from "./lib/ledger-read.js";
import { schedulerProjectView } from "./lib/ledger-scheduler.js";
import { schedulerPass } from "./lib/scheduler-pass.js";
import { acquireLock } from "./lib/file-lock.js";
import { statePath } from "./lib/paths.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SchedulerStopped } from "./lib/scheduler-maintenance.js";
import { lendStep, lendWanted } from "./lib/lend-deps.js";

export async function runScheduler(signal: AbortSignal, wait: (ms: number) => Promise<void> = Bun.sleep,
  lockPath = statePath("scheduler.pid")): Promise<void> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const lock = await acquireLock(lockPath, 0);
  if (!lock) throw new Error("another scheduler holds scheduler.pid");
  // A stop gives the singleton up at once: a manager / ledger child still queued on the write lock then finds the lease gone
  // and writes nothing (lib/scheduler-lease-env.ts). The pass sees held() = false and ends at its next check.
  signal.addEventListener("abort", () => lock.release(), { once: true });
  const reader = new LedgerReader();
  let lastError = "";
  const cursor: Record<string, string | undefined> = {}; // where each loop stopped: the next pass resumes after it
  try {
    while (!signal.aborted) {
      if (!lock.held()) throw new Error("scheduler lost its singleton lock");
      let pollMs = 5000;
      try {
        const config = readSchedulerConfig();
        pollMs = config.pollMs;
        // 两个开关任一开着就跑 pass：scheduler.json 管合并 / 观察 / 自动派单，lend.json（或还没跑完的出借单）管出借这一步
        const lend = await lendWanted();
        if (config.enabled || lend) {
          const db = reader.get();
          if (config.enabled && !db) throw new Error("scheduler enabled but ledger is unavailable");
          if (db && config.enabled) for (const project of Object.keys(config.projects)) schedulerProjectView(db, project);
          const { failed } = await schedulerPass(db, config, { singleton: { path: lockPath, token: lock.token }, cursor, assertOwner: () => {
            if (signal.aborted || !lock.held()) throw new SchedulerStopped("scheduler stopped or lost singleton lease");
          }, ...(lend ? { lend: lendStep(reader) } : {}) });
          if (failed.length) throw new Error(`tick failed: ${failed.map((f) => `${f.taskId} ${f.error}`).join("; ").slice(0, 500)}`);
        }
        if (lastError) console.error("scheduler recovered");
        lastError = "";
      } catch (e) {
        if (e instanceof SchedulerStopped) break;
        const error = (e as Error).message;
        if (error !== lastError) console.error(`scheduler idle: ${error}`);
        lastError = error;
      }
      if (!signal.aborted) await wait(pollMs);
    }
  } finally { reader.close(); lock.release(); }
}

if (import.meta.main) {
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
  await runScheduler(stop.signal);
}
