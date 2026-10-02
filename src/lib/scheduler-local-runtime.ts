/** Project-local author selection and an adapter to the canonical authorized, audited config writer. */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-write.js";
import { readSchedulerConfig, SCHEDULER_CONFIG_PATH } from "./scheduler-config.js";
import { setLocalSlots } from "./scheduler-config-write.js";
import type { LocalAuthorRuntime } from "./scheduler-local-runtime-config.js";

export function localAuthorRuntime(project: string, path = SCHEDULER_CONFIG_PATH): LocalAuthorRuntime {
  return readSchedulerConfig(path).projects[project]?.localAuthorRuntime ?? "claude";
}

/** The existing writer owns permissions, reason validation, deduplication and audit-failure rollback. */
export function setLocalAuthorRuntime(db: Database, ctx: WriteCtx, input: { project: string; runtime: LocalAuthorRuntime; reason: string },
  opts: { path?: string; lockMs?: number } = {}) {
  return setLocalSlots(db, ctx, { project: input.project, set: { localAuthorRuntime: input.runtime }, reason: input.reason }, opts);
}
