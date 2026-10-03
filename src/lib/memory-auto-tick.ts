/** The service's query-only connection dispatches automatic writes through its lease-guarded manager. */
import type { Database } from "bun:sqlite";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { pendingAutoEvents } from "./memory-auto-common.js";

export async function memoryAutoTick(db: Database, projects: readonly string[],
  manager: (...args: string[]) => Promise<Record<string, unknown>>): Promise<{ taskId: string; error: string }[]> {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories'").get()) return [];
  const failed: { taskId: string; error: string }[] = [];
  for (const project of projects) {
    if (!pendingAutoEvents(db, project, 1).length) continue;
    try {
      const r = await manager("ledger", "memory-auto", "--project", project);
      if (r.code === "lease-lost") throw new SchedulerStopped("memory observer lost scheduler lease");
      if (r.ok !== true) failed.push({ taskId: `memory ${project}`, error: String(r.error ?? "memory observer failed").slice(0, 300) });
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      failed.push({ taskId: `memory ${project}`, error: "memory observer unavailable" });
    }
  }
  return failed;
}
