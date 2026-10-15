/** Browser wire types for the add-only shared-ledger reads (src/lib/shared-ledger-contract-reads.ts is the single schema;
 * the bridge parses strictly before answering, contract tests check these types against its fixtures).
 * Consumers ask `SharedLedgerReads`, which never sends a read the center has not advertised.
 */
import { api, ApiError } from "./client";
import type { MachineRef } from "../machines";
import { sharedLedgerProjectHeaders, type PlanNode } from "./shared-ledger";

export interface ExtCapabilities {
  schemaVersion: 1; teamId: string;
  reads: { versions: boolean; activity: boolean; ext1: boolean; activityExt: boolean };
  uploads: { projectionExt1: boolean };
}
export interface FeatureVersion {
  version: number; reason: string; nodes: PlanNode[]; bindings: { nodeKey: string; taskId: string }[]; at: number | null; by: string | null;
}
export interface FeatureVersions { schemaVersion: 1; teamId: string; projectId: string; serverSeq: number; versions: FeatureVersion[] }
export type ActivityItem =
  | { src: "center"; serverSeq: number; kind: string; by: string; at: number }
  | { src: "home"; sourceSeq: number; taskId: string; type: string; at: number };
export interface FeatureActivity { schemaVersion: 1; teamId: string; projectId: string; serverSeq: number; items: ActivityItem[]; truncated: boolean }
/** Hand copy of src/lib/shared-ledger-contract-task-facts.ts (no twin; tests assign both ways). Ids, kinds and times only. */
const TASK_FACT_KINDS = ["stage", "deliver", "review", "verify", "deploy", "ask", "ask_cancel", "decision", "dispatch"] as const;
type TaskFactKind = typeof TASK_FACT_KINDS[number];
/** Same limits as the contract: `id` shape (shared-ledger-contract-schema.ts) and the detail tasks cap. */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const MAX_TASK_FACTS = 1000;
export interface TaskFact { taskId: string; stageSince: number | null; doneAt: number | null; lastEvent: { at: number; kind: TaskFactKind } | null }
export interface TaskFacts { schemaVersion: 1; teamId: string; projectId: string; featureId: string; serverSeq: number; tasks: TaskFact[] }
export type ReadCapabilities = Pick<ExtCapabilities, "reads" | "uploads">;
/** Unreadable capabilities (old center 404, offline, other team) mean every extension is off. */
export const READS_OFF: ReadCapabilities = Object.freeze({
  reads: Object.freeze({ versions: false, activity: false, ext1: false, activityExt: false }), uploads: Object.freeze({ projectionExt1: false }),
});

export interface ReadsTransport {
  extCapabilities(signal: AbortSignal): Promise<ExtCapabilities>;
  versions(id: string, signal: AbortSignal): Promise<FeatureVersions>;
  activity(id: string, afterServerSeq: number, signal: AbortSignal): Promise<FeatureActivity>;
  taskFacts(id: string, signal: AbortSignal): Promise<TaskFacts>;
}
/** Cursor goes in the path: the bridge proxy answers 400 to any query string. */
export function sharedLedgerReadsTransport(machine?: MachineRef, project?: string): ReadsTransport {
  const root = "/shared-ledger", headers = sharedLedgerProjectHeaders(project);
  return {
    extCapabilities: signal => api(`${root}/ext-capabilities`, { signal, headers }, machine),
    versions: (id, signal) => api(`${root}/features/${encodeURIComponent(id)}/versions`, { signal, headers }, machine),
    activity: (id, after, signal) => api(`${root}/features/${encodeURIComponent(id)}/activity/${after}`, { signal, headers }, machine),
    taskFacts: (id, signal) => api(`${root}/features/${encodeURIComponent(id)}/task-facts`, { signal, headers }, machine),
  };
}

/** One per identity. `null` = capability off, no request was sent; the caller keeps its "unavailable" state. */
export class SharedLedgerReads {
  private caps: ReadCapabilities | null = null;
  constructor(private identity: { team: string; project: string }, private transport: ReadsTransport) {}
  async capabilities(signal: AbortSignal): Promise<ReadCapabilities> {
    if (this.caps) return this.caps;
    try {
      const caps = await this.transport.extCapabilities(signal);
      if (caps.teamId !== this.identity.team) return READS_OFF;
      this.caps = { reads: caps.reads, uploads: caps.uploads };
      return this.caps;
    } catch (error) {
      // Not cached: a transient failure only hides history until the next attempt; aborts still reach the caller.
      if (signal.aborted) throw error;
      return READS_OFF;
    }
  }
  async versions(id: string, signal: AbortSignal): Promise<FeatureVersions | null> {
    if (!(await this.capabilities(signal)).reads.versions) return null;
    return this.own(await this.transport.versions(id, signal));
  }
  async activity(id: string, afterServerSeq: number, signal: AbortSignal): Promise<FeatureActivity | null> {
    if (!Number.isSafeInteger(afterServerSeq) || afterServerSeq < 0) throw new Error("invalid_cursor");
    if (!(await this.capabilities(signal)).reads.activity) return null;
    return this.own(await this.transport.activity(id, afterServerSeq, signal));
  }
  /** Standalone read, not gated by ext-capabilities. `null` on any failure; nothing is cached and no backoff is kept here. */
  async taskFacts(id: string, signal: AbortSignal): Promise<TaskFacts | null> {
    try {
      return this.ownFacts(id, await this.transport.taskFacts(id, signal));
    } catch (error) {
      if (signal.aborted) throw error;
      // Harmless to swallow: facts only decorate sub-DAG cards, the caller keeps its plain card and decides when to ask again.
      // 403 is the old center's normal answer (no route), so it is not logged; other failures log the status only.
      const status = error instanceof ApiError ? error.status : null;
      if (status !== 403 && status !== 404) console.warn(`shared ledger task-facts unavailable (${status ?? "no status"})`);
      return null;
    }
  }
  /** Rebuilt field by field with the contract's rules: extra keys never reach the caller, a wrong shape or identity counts as a failure. */
  private ownFacts(id: string, raw: TaskFacts): TaskFacts | null {
    const r = raw as unknown as Record<string, unknown>;
    if (r.teamId !== this.identity.team || r.projectId !== this.identity.project || r.featureId !== id) return null;
    const seq = r.serverSeq;
    if (r.schemaVersion !== 1 || !Number.isSafeInteger(seq) || (seq as number) < 0 || !Array.isArray(r.tasks) || r.tasks.length > MAX_TASK_FACTS) bad();
    const time = (v: unknown) => v === null || (Number.isSafeInteger(v) && (v as number) > 0) ? v as number | null : bad();
    const seen = new Set<string>();
    const tasks = r.tasks.map((row: unknown): TaskFact => {
      const t = (row && typeof row === "object" ? row : bad()) as Record<string, unknown>;
      const e = t.lastEvent as Record<string, unknown> | null;
      if (typeof t.taskId !== "string" || !TASK_ID.test(t.taskId) || seen.has(t.taskId)) bad();
      if (e !== null && (typeof e !== "object" || !TASK_FACT_KINDS.includes(e.kind as TaskFactKind))) bad();
      seen.add(t.taskId as string);
      const fact: TaskFact = { taskId: t.taskId as string, stageSince: time(t.stageSince), doneAt: time(t.doneAt),
        lastEvent: e === null ? null : { at: time(e.at) ?? bad(), kind: e.kind as TaskFactKind } };
      if (fact.doneAt !== null && (fact.stageSince !== null || fact.lastEvent !== null)) bad();
      return fact;
    });
    return { schemaVersion: 1, teamId: this.identity.team, projectId: this.identity.project, featureId: id, serverSeq: seq as number, tasks };
  }
  private own<T extends { teamId: string; projectId: string }>(result: T): T {
    if (result.teamId !== this.identity.team || result.projectId !== this.identity.project) throw new Error("invalid_snapshot");
    return result;
  }
}
function bad(): never { throw new Error("invalid_task_facts"); }
