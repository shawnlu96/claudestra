/** S2C fake center state: plain in-memory rows (structuredClone-able, so a command runs on a draft and a backup is a clone).
 * Test fixture only — not a reference for the real center. Ids are synthetic; nothing reads production state.
 */
import {
  assertFence, capabilities, fail, V2_COMMAND_NAMES, V2_COMMAND_POLICY, V2_LEASE_MS,
  type V2Ask, type V2Command, type V2Dependency, type V2Fence, type V2Feature, type V2Intent, type V2Lease,
  type V2LendLease, type V2LendOrder, type V2Receipt, type V2Resource, type V2Step, type V2Task, type V2Workflow,
} from "../../src/lib/shared-ledger-contract-v2.js";
import { V2_ROUTES } from "../../src/lib/shared-ledger-contract-v2-routes.js";

export type FakeDag = { version: number; nodes: { key: string; oneLine: string; deps: string[]; fileGlobs: string[]; estimate: string }[];
  bindings: { nodeKey: string; taskId: string }[] };
export type FakeMigrationResult = ReturnType<typeof V2_ROUTES.migrations.parseResponse>;
export type FakeRevertResult = ReturnType<typeof V2_ROUTES.reverts.parseResponse>;
export type FakeFeatureView = ReturnType<typeof V2_ROUTES.features.parseResponse>;

export interface FakeCenterState {
  serverSeq: number;
  features: Map<string, V2Feature>;
  dags: Map<string, FakeDag>;
  tasks: Map<string, V2Task>;
  dependencies: V2Dependency[];
  steps: V2Step[];
  workflows: Map<string, V2Workflow>;
  asks: Map<string, V2Ask>;
  leases: Map<string, V2Lease>;
  /** Lease terms, independent of the clock (two terms can share a millisecond): every fresh acquire takes ++leaseTermSeq,
   * leaseTerms holds the live lease's term per task and intentTerms the term each intent was created in. */
  leaseTermSeq: number;
  leaseTerms: Map<string, number>;
  intentTerms: Map<string, number>;
  intents: Map<string, V2Intent>;
  resources: V2Resource[];
  orders: Map<string, V2LendOrder>;
  lendLeases: Map<string, V2LendLease>;
  /** Keyed by JSON [personId, instanceId, requestId]: the dedup identity of a command. */
  receipts: Map<string, V2Receipt>;
  migrations: Map<string, FakeMigrationResult>;
  /** batchId → the committed result plus the digest of the request that produced it (a different body is dedup_mismatch). */
  reverts: Map<string, { requestDigest: string; result: FakeRevertResult }>;
}
export function emptyState(): FakeCenterState {
  return {
    serverSeq: 0, features: new Map(), dags: new Map(), tasks: new Map(), dependencies: [], steps: [], workflows: new Map(),
    asks: new Map(), leases: new Map(), leaseTermSeq: 0, leaseTerms: new Map(), intentTerms: new Map(), intents: new Map(), resources: [], orders: new Map(), lendLeases: new Map(),
    receipts: new Map(), migrations: new Map(), reverts: new Map(),
  };
}
export const receiptKey = (personId: string, instanceId: string, requestId: string) => JSON.stringify([personId, instanceId, requestId]);
export const fenceOf = (f: V2Fence): V2Fence => ({ serviceGeneration: f.serviceGeneration, epoch: f.epoch, bootId: f.bootId });

export function must<T>(value: T | undefined | null): T { return value ?? fail("not_found"); }
/** An owner authorization ask the center holds: answered approved and not past its own expiry (null = none needed). */
export function authorizeAsk(state: FakeCenterState, askId: string | null, now: number): void {
  if (askId === null) return;
  const ask = state.asks.get(askId);
  if (!ask || ask.state !== "answered" || ask.decision !== "approved") fail("authorization_mismatch");
  if (ask.expiresAt <= now) fail("authorization_expired");
}
function featureOfTask(state: FakeCenterState, taskId: string): V2Feature {
  return must(state.features.get(must(state.tasks.get(taskId)).featureId));
}

/** Which feature a command touches, from its payload references; null only for commands that create a feature-less row. */
export function commandFeature(state: FakeCenterState, c: V2Command): V2Feature | null {
  const p = c.payload as Record<string, any>;
  if (c.type === "feature.new") return null;
  if (typeof p.featureId === "string") return must(state.features.get(p.featureId));
  const taskId: unknown = p.taskId ?? p.fromTask ?? p.result?.taskId ?? p.claim?.taskId ?? p.artifact?.taskId
    ?? (typeof p.intentId === "string" ? must(state.intents.get(p.intentId)).taskId : undefined)
    ?? (typeof p.orderId === "string" ? must(state.orders.get(p.orderId)).taskId : undefined);
  if (typeof taskId === "string") return featureOfTask(state, taskId);
  if (typeof p.askId === "string") return must(state.features.get(must(state.asks.get(p.askId)).featureId));
  return null;
}

/** Commands the center would offer on this feature: execution features offer every command, others no executionOnly one. */
function featureCapabilities(feature: V2Feature) {
  return capabilities(V2_COMMAND_NAMES.filter(n => feature.authorityMode === "execution" || !V2_COMMAND_POLICY[n].executionOnly));
}

/** The live home lease of a task, held under exactly this fence; lease_expired when absent or past its central expiry. */
export function requireLease(state: FakeCenterState, taskId: string, fence: V2Fence, now: number): V2Lease {
  const lease = state.leases.get(taskId);
  if (!lease || lease.expiresAt <= now) return fail("lease_expired");
  assertFence(fenceOf(lease), fenceOf(fence));
  return lease;
}
export function newLease(c: V2Command & { payload: { taskId: string } }, home: string, now: number): V2Lease {
  return { teamId: c.teamId, projectId: c.projectId, taskId: c.payload.taskId, homeInstanceId: home, holderInstanceId: home,
    ...fenceOf(c), acquiredAt: now, renewedAt: now, expiresAt: now + V2_LEASE_MS };
}

/** GET features/{id}: the feature's rows, validated by the S2K parser so the fixture never serves a contract-invalid body. */
export function featureView(state: FakeCenterState, scope: { teamId: string; projectId: string },
  serviceGeneration: number, featureId: string): FakeFeatureView {
  const feature = must(state.features.get(featureId));
  const tasks = [...state.tasks.values()].filter(t => t.featureId === featureId), ids = new Set(tasks.map(t => t.id));
  const intents = [...state.intents.values()].filter(i => ids.has(i.taskId));
  const view = {
    ...scope, serverSeq: state.serverSeq, serviceGeneration, feature, dag: state.dags.get(featureId) ?? null, tasks,
    dependencies: state.dependencies.filter(d => ids.has(d.fromTask) && ids.has(d.toTask)),
    steps: state.steps.filter(s => ids.has(s.taskId)),
    workflows: [...state.workflows.values()].filter(w => ids.has(w.taskId)), intents,
    resources: state.resources.filter(r => intents.some(i => i.id === r.intentId)),
    pendingAsks: [...state.asks.values()].filter(a => a.featureId === featureId && a.state === "open"),
    capabilities: featureCapabilities(feature),
  };
  return V2_ROUTES.features.parseResponse(structuredClone(view), { ...scope, featureId });
}

/** Live work that blocks a revert: an unexpired lease, a live or unknown intent, a pooled / claimed / unknown lend order. */
export function liveWork(state: FakeCenterState, featureId: string, now: number): boolean {
  const ids = new Set([...state.tasks.values()].filter(t => t.featureId === featureId).map(t => t.id));
  return [...state.leases.values()].some(l => ids.has(l.taskId) && l.expiresAt > now)
    || [...state.intents.values()].some(i => ids.has(i.taskId) && ["pending", "submitted", "unknown"].includes(i.status))
    || [...state.orders.values()].some(o => ids.has(o.taskId) && ["pooled", "claimed", "unknown"].includes(o.status));
}
