/** Browser wire types for the add-only shared-ledger reads (src/lib/shared-ledger-contract-reads.ts is the single schema;
 * the bridge parses strictly before answering, contract tests check these types against its fixtures).
 * Consumers ask `SharedLedgerReads`, which never sends a read the center has not advertised.
 */
import { api } from "./client";
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
export type ReadCapabilities = Pick<ExtCapabilities, "reads" | "uploads">;
/** Unreadable capabilities (old center 404, offline, other team) mean every extension is off. */
export const READS_OFF: ReadCapabilities = Object.freeze({
  reads: Object.freeze({ versions: false, activity: false, ext1: false, activityExt: false }), uploads: Object.freeze({ projectionExt1: false }),
});

export interface ReadsTransport {
  extCapabilities(signal: AbortSignal): Promise<ExtCapabilities>;
  versions(id: string, signal: AbortSignal): Promise<FeatureVersions>;
  activity(id: string, afterServerSeq: number, signal: AbortSignal): Promise<FeatureActivity>;
}
/** Cursor goes in the path: the bridge proxy answers 400 to any query string. */
export function sharedLedgerReadsTransport(machine?: MachineRef, project?: string): ReadsTransport {
  const root = "/shared-ledger", headers = sharedLedgerProjectHeaders(project);
  return {
    extCapabilities: signal => api(`${root}/ext-capabilities`, { signal, headers }, machine),
    versions: (id, signal) => api(`${root}/features/${encodeURIComponent(id)}/versions`, { signal, headers }, machine),
    activity: (id, after, signal) => api(`${root}/features/${encodeURIComponent(id)}/activity/${after}`, { signal, headers }, machine),
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
  private own<T extends { teamId: string; projectId: string }>(result: T): T {
    if (result.teamId !== this.identity.team || result.projectId !== this.identity.project) throw new Error("invalid_snapshot");
    return result;
  }
}
