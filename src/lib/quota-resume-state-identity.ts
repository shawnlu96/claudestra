/** Read-only target facts: corrupt registry / ledger never mean a new target is safe to wake. */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { cardWorkerIndex, activeWorkers } from "./agent-lifecycle-store.js";
import { statePath } from "./paths.js";
import { normalizeRegistryAgents, REGISTRY_PATH } from "./registry.js";
import { schedulerV2SkipTask } from "./scheduler-v2-skip-card.js";
import { readJsonStateSync } from "./state-file.js";
import type { ResumeTarget } from "./quota-resume-state.js";

/** Explicit paths make every test use only synthetic registry and ledger files. No credentials or quota state are read. */
export function readQuotaResumeTarget(cid: string, agent: string,
  paths = { registry: REGISTRY_PATH, ledger: statePath("ledger.sqlite") }): ResumeTarget {
  const registry = readJsonStateSync(paths.registry);
  if (registry.status !== "ok") return { kind: "unknown", reason: "registry_unreadable" };
  const a = normalizeRegistryAgents(registry.data).find((r) => r.channelId === cid);
  if (!a) return { kind: "cancelled", reason: "target_removed" };
  if (a.name !== agent || (a.status && a.status !== "active") || (a.runtime && a.runtime !== "claude-code")) {
    return { kind: "cancelled", reason: "target_retired_or_replaced" };
  }
  if (!a.sessionId) return { kind: "unknown", reason: "session_missing" };
  let db: Database | undefined;
  try {
    db = existsSync(paths.ledger) ? new Database(paths.ledger, { readonly: true }) : undefined;
    if (!db) {
      return a.kind === "worker" ? { kind: "unknown", reason: "worker_ledger_missing" }
        : { kind: "ready", identity: { sessionId: a.sessionId, taskKey: "user_session" } };
    }
    const indexed = cardWorkerIndex(db).get(a.name)?.links ?? [];
    const bound = indexed.filter((l) => l.source !== "tasks.agent");
    // Historical tasks.agent rows name no session; a current registration wins over those old task associations.
    const links = bound.length ? bound : indexed;
    if (links.some((l) => l.sessionId && l.sessionId !== a.sessionId)) return { kind: "unknown", reason: "registration_conflict" };
    if (a.kind === "worker" && !links.some((l) => l.sessionId === a.sessionId)) return { kind: "unknown", reason: "worker_binding_missing" };
    const taskIds = [...new Set(links.flatMap((l) => l.taskId ? [l.taskId] : []))].sort();
    for (const id of taskIds) {
      const task = db.query("SELECT stage, extra FROM tasks WHERE id = ?").get(id) as { stage: string; extra: string | null } | null;
      if (!task) return { kind: "unknown", reason: "task_missing" };
      if (["verified", "done", "cancelled"].includes(task.stage)) return { kind: "cancelled", reason: "task_finished" };
      const extra = task.extra ? JSON.parse(task.extra) : {};
      if (!extra || typeof extra !== "object" || Array.isArray(extra)) return { kind: "unknown", reason: "task_unreadable" };
      if (extra.frozen === true || schedulerV2SkipTask(db, id)) return { kind: "unknown", reason: "task_protected" };
    }
    const generations = activeWorkers(db).filter((r) => r.agent === agent && r.sessionId === a.sessionId)
      .map((r) => [r.taskId, r.createdAt, r.role]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { kind: "ready", identity: { sessionId: a.sessionId, taskKey: JSON.stringify({ taskIds, generations }) } };
  } catch (e) {
    console.error(`额度恢复 ${agent}：台账失读，保持待核：${(e as Error).message}`);
    return { kind: "unknown", reason: "ledger_unreadable" };
  } finally { db?.close(); }
}
