/** Browser wire types mirror the frozen shared-ledger contract; contract tests check assignability. */
import { api } from "./client";
import type { MachineRef } from "../machines";
export interface PlanNode { key: string; oneLine: string; deps: string[]; fileGlobs: string[]; estimate: string }
export type Capability = { enabled: boolean; code?: string; reason?: string };
export type Capabilities = Record<string, Capability>;
export interface Feature {
  id: string; projectId: string; title: string; description: string; rev: number; version: number;
  authorityMode: "source" | "planning"; homeInstanceId: string; executorInstanceIds: string[];
  status: "planned" | "active" | "done" | "blocked";
  counts: { total: number; completed: number; blocked: number; missing: number };
  updatedBy: string; updatedAt: number;
  projection: { sourceInstanceId: string; sourceSeq: number; observedAt: number; receivedAt: number } | null;
}
export interface Snapshot { schemaVersion: 1; teamId: string; serverSeq: number; capabilities: Capabilities }
export interface FeatureList extends Snapshot { features: Feature[] }
export interface TaskProjection {
  taskId: string; sourceTaskId: string; sourceRev: number; sourceSeq: number; stage: string;
  assigneeCode: string | null; executorInstanceId: string | null; pr: number | null; head: string | null;
  deps: string[]; specSummary: string; specDigest: string | null; fullText: "home_only";
  steps: { sourceStepId: string; sourceRev: number; sourceSeq: number; state: string }[];
  asks: { kind: string; state: string; blocking: boolean }[];
}
export interface FeatureDetail extends Snapshot {
  feature: Feature; dag: { version: number; nodes: PlanNode[]; bindings: { nodeKey: string; taskId: string }[] };
  tasks: TaskProjection[];
}
export type Command =
  | { type: "feature.new"; requestId: string; projectId: string; title: string; description: string; homeInstanceId: string }
  | { type: "feature.set"; requestId: string; projectId: string; featureId: string; expectedRev: number;
      patch: { title?: string; description?: string } }
  | { type: "dag.init" | "dag.rewrite"; requestId: string; projectId: string; featureId: string;
      expectedRev: number; baseVersion: number; nodes: PlanNode[]; reason: string };
export interface Result {
  schemaVersion: 1; requestId: string; commandDigest: string; serverSeq: number; committedAt: number;
  result: { featureId: string; rev: number; version: number };
}
export type Receipt = { status: "committed"; receipt: Result } | { status: "unknown"; requestId: string };
export interface Identity { center: string; team: string; person: string; project: string; machine: string; homeInstanceId?: string }
export const identityKey = (i: Identity) => JSON.stringify([i.center, i.team, i.person, i.project, i.machine]);
export interface Transport {
  list(signal: AbortSignal): Promise<FeatureList>;
  detail(id: string, signal: AbortSignal): Promise<FeatureDetail>;
  command(command: Command, signal: AbortSignal): Promise<Result>;
  receipt(id: string, signal: AbortSignal): Promise<Receipt>;
}
export const sharedLedgerProjectHeaders = (project?: string) => project ? { "X-Shared-Ledger-Project": project } : undefined;
/** `project` (center project id) selects the bridge binding when this machine joined several projects. */
export function sharedLedgerTransport(machine?: MachineRef, project?: string): Transport {
  const root = "/shared-ledger";
  const headers = sharedLedgerProjectHeaders(project);
  return {
    list: signal => api(`${root}/features`, { signal, headers }, machine),
    detail: (id, signal) => api(`${root}/features/${encodeURIComponent(id)}`, { signal, headers }, machine),
    command: (json, signal) => api(`${root}/commands`, { method: "POST", json, signal, headers }, machine),
    receipt: (id, signal) => api(`${root}/commands/${encodeURIComponent(id)}`, { signal, headers }, machine),
  };
}
/** A session owns its request generation. Late responses cannot mutate any identity's cache. */
export class SharedLedgerSession {
  private ctrl = new AbortController();
  private epoch = 0;
  private cache = new Map<string, FeatureList>();
  constructor(public identity: Identity, private transport: Transport) {}
  switchIdentity(identity: Identity, transport: Transport): void {
    this.ctrl.abort(); this.ctrl = new AbortController(); this.epoch++;
    this.identity = identity; this.transport = transport;
  }
  activate(): void { if (this.ctrl.signal.aborted) this.ctrl = new AbortController(); }
  close(): void { this.ctrl.abort(); this.epoch++; }
  cached(): FeatureList | undefined { return this.cache.get(identityKey(this.identity)); }
  async list(): Promise<FeatureList | undefined> {
    const epoch = this.epoch, key = identityKey(this.identity), signal = this.ctrl.signal;
    let next = await this.transport.list(signal);
    if (epoch !== this.epoch || signal.aborted) return;
    const old = this.cache.get(key);
    if (next.schemaVersion !== 1 || next.teamId !== this.identity.team || !Array.isArray(next.features)) throw new Error("invalid_snapshot");
    if (old && next.serverSeq < old.serverSeq) {
      next = await this.transport.list(signal);
      if (epoch !== this.epoch || signal.aborted) return;
      if (next.teamId !== this.identity.team || next.schemaVersion !== 1 || !Array.isArray(next.features)) throw new Error("invalid_snapshot");
    }
    if (old?.serverSeq === next.serverSeq) return old;
    this.cache.set(key, next); return next;
  }
  async detail(id: string): Promise<FeatureDetail | undefined> {
    const epoch = this.epoch, signal = this.ctrl.signal;
    const next = await this.transport.detail(id, signal);
    if (epoch !== this.epoch || signal.aborted) return;
    if (next.teamId !== this.identity.team || next.feature.projectId !== this.identity.project) throw new Error("invalid_snapshot");
    return next;
  }
  async receipt(id: string): Promise<Receipt | undefined> {
    const epoch = this.epoch, signal = this.ctrl.signal;
    const result = await this.transport.receipt(id, signal);
    return epoch === this.epoch && !signal.aborted ? result : undefined;
  }
  async submit(command: Command): Promise<Result | undefined> {
    const epoch = this.epoch, signal = this.ctrl.signal;
    const result = await this.transport.command(command, signal);
    return epoch === this.epoch && !signal.aborted ? result : undefined;
  }
}
