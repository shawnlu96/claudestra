/** N7B pending-sync journal for feature proposals sent to the center: one 0600 file, read-modify-write under its lock.
 * It holds only the operation (operationId, the exact body and its digest, state, expiry); no local feature / DAG / card
 * is ever written for a bound team project. The body is kept so a resend carries the same digest.
 * Resume rule: ask the center first by operationId, resend the same body only when it has no record; changed content
 * gets a new operationId (contentKey); owner decisions are never stored or replayed here.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "./file-lock.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { instanceIdSync } from "./instance-id.js";
import { instanceKeySync, type InstanceKey } from "./instance-key.js";
import { resolveSharedLedgerCredential } from "./shared-ledger-mode.js";
import { SharedLedgerUnavailable } from "./shared-ledger-client-transport.js";
import { v2ObjectDigest } from "./shared-ledger-contract-v2-integrity.js";
import {
  FEATURE_PROPOSAL_LIMITS, PROPOSAL_OPERATION_STATES, proposalDigest, type FeatureProposalNew, type ProposalOperation,
} from "./shared-ledger-contract-v2-feature-proposals.js";
import { FeatureProposalRejected, FeatureProposalUnsupported, SharedLedgerFeatureProposalClient, type FeatureProposalScope } from "./shared-ledger-feature-proposals.js";

export type ProposalVia = "person" | "service";
type PendingState = "unsynced" | ProposalOperation["state"];
type PendingIssue = "unavailable" | "unsupported" | "no_credential" | "forbidden" | "rejected_request" | null;
export interface PendingProposal {
  operationId: string; localProjectId: string; via: ProposalVia; contentKey: string;
  proposal: FeatureProposalNew; proposalDigest: string; state: PendingState; issue: PendingIssue;
  proposalId: string | null; featureId: string | null; version: number | null;
  attempts: number; expiresAt: number; createdAt: number; updatedAt: number;
}
interface PendingFile { schemaVersion: 1; operations: Record<string, PendingProposal> }
const FEATURE_PROPOSALS_FILE = "shared-feature-proposals.json";
export const PROPOSAL_DEFAULT_TTL_MS = 72 * 3_600_000;
const TERMINAL: readonly PendingState[] = ["published", "rejected", "expired", "conflict"];
const STATES: readonly PendingState[] = ["unsynced", ...PROPOSAL_OPERATION_STATES];
const RETAIN_MS = 30 * 24 * 3_600_000;

export interface ProposalRuntime {
  stateDir: string; now: () => number; newOperationId: () => string; ttlMs: number; fetch?: typeof fetch;
  key?: () => InstanceKey | null; instanceId?: () => string;
}

const path = (dir: string) => join(dir, FEATURE_PROPOSALS_FILE);
function validFile(v: unknown): v is PendingFile {
  if (!v || typeof v !== "object" || (v as PendingFile).schemaVersion !== 1) return false;
  const ops = (v as PendingFile).operations;
  return !!ops && typeof ops === "object" && !Array.isArray(ops) && Object.entries(ops).every(([id, r]) => !!r && r.operationId === id
    && STATES.includes(r.state) && (r.via === "person" || r.via === "service") && typeof r.proposalDigest === "string"
    && typeof r.contentKey === "string" && !!r.proposal && Number.isSafeInteger(r.expiresAt) && Number.isSafeInteger(r.attempts));
}
export function readPendingProposals(dir: string): PendingProposal[] {
  const s = readJsonStateSync(path(dir), validFile);
  if (s.status === "missing") return [];
  if (s.status !== "ok") throw new Error("feature proposal journal invalid");
  return Object.values((s.data as PendingFile).operations);
}
async function mutate<T>(dir: string, fn: (ops: Record<string, PendingProposal>) => T): Promise<T> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(`${path(dir)}.lock`);
  if (!lock) throw new Error("feature proposal journal lock unavailable");
  try {
    const ops: Record<string, PendingProposal> = Object.fromEntries(readPendingProposals(dir).map(r => [r.operationId, r]));
    const out = fn(ops);
    const file: PendingFile = { schemaVersion: 1, operations: ops };
    writeJsonAtomicSync(path(dir), file, { mode: 0o600, commitIf: lock.held });
    return out;
  } finally { lock.release(); }
}

/** Everything that defines the proposal except operationId / expiresAt: equal content reuses the operation. */
export type ProposalDraft = Omit<FeatureProposalNew, "operationId" | "expiresAt">;
const contentKeyOf = (draft: ProposalDraft, localProjectId: string, via: ProposalVia) => v2ObjectDigest({ draft, localProjectId, via });

/** Returns the one record for this content (concurrent equal calls share it); a new one gets a fresh operationId. */
export async function stageProposal(rt: ProposalRuntime, draft: ProposalDraft, localProjectId: string, via: ProposalVia): Promise<PendingProposal> {
  const contentKey = contentKeyOf(draft, localProjectId, via);
  return mutate(rt.stateDir, ops => {
    const now = rt.now();
    for (const [id, r] of Object.entries(ops)) if (TERMINAL.includes(r.state) && r.updatedAt + RETAIN_MS < now) delete ops[id];
    const same = Object.values(ops).find(r => r.contentKey === contentKey && (r.state !== "unsynced" || r.expiresAt > now));
    if (same) return same;
    const ttl = Math.min(rt.ttlMs, FEATURE_PROPOSAL_LIMITS.maxTtlMs);
    let operationId = rt.newOperationId();
    while (ops[operationId]) operationId = rt.newOperationId();
    const proposal = { ...draft, operationId, expiresAt: now + ttl } as FeatureProposalNew;
    const record: PendingProposal = { operationId, localProjectId, via, contentKey, proposal, proposalDigest: proposalDigest(proposal),
      state: "unsynced", issue: null, proposalId: null, featureId: null, version: null, attempts: 0,
      expiresAt: proposal.expiresAt, createdAt: now, updatedAt: now };
    ops[operationId] = record;
    return record;
  });
}

async function patch(rt: ProposalRuntime, operationId: string, change: Partial<PendingProposal>): Promise<PendingProposal> {
  return mutate(rt.stateDir, ops => {
    const r = ops[operationId];
    if (!r) throw new Error("feature proposal record missing");
    ops[operationId] = { ...r, ...change, updatedAt: rt.now() };
    return ops[operationId]!;
  });
}
const fromOperation = (op: ProposalOperation): Partial<PendingProposal> =>
  ({ state: op.state, issue: null, proposalId: op.proposalId, featureId: op.featureId, version: op.version });

const scopeOf = (r: PendingProposal): FeatureProposalScope => ({ centerId: r.proposal.centerId, teamId: r.proposal.teamId, projectId: r.proposal.projectId });
/** PM / MCP uses owner:self's service credential (as the mirror does), web uses owner:self's person credential. */
function proposalCredential(rt: ProposalRuntime, scope: FeatureProposalScope, via: ProposalVia) {
  const c = resolveSharedLedgerCredential("owner:self", via, scope.centerId, scope.teamId, scope.projectId, "plan", rt.stateDir);
  const instanceId = (rt.instanceId ?? (() => instanceIdSync(rt.stateDir)))();
  return c && c.kind === via && instanceId && c.instanceId === instanceId ? c : null;
}

const inFlight = new Map<string, Promise<PendingProposal>>();
/** One sync per operation at a time in this process; concurrent callers share the same attempt. */
export function syncProposal(rt: ProposalRuntime, operationId: string, opts: { queryFirst?: boolean } = {}): Promise<PendingProposal> {
  const key = `${rt.stateDir}\0${operationId}`;
  const running = inFlight.get(key);
  if (running) return running;
  const p = syncOnce(rt, operationId, opts).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function syncOnce(rt: ProposalRuntime, operationId: string, opts: { queryFirst?: boolean }): Promise<PendingProposal> {
  const r = readPendingProposals(rt.stateDir).find(x => x.operationId === operationId);
  if (!r) throw new Error("feature proposal record missing");
  if (TERMINAL.includes(r.state)) return r;
  const now = rt.now();
  // Never sent (attempts is bumped before any submit) → the center cannot have it, TTL alone decides. Once it may have
  // been sent, only a center "no record" lets the TTL expire it: a lost reply past expiresAt may still be published.
  if (r.state === "unsynced" && r.attempts === 0 && r.expiresAt <= now) return patch(rt, operationId, { state: "expired", issue: null });
  const credential = proposalCredential(rt, scopeOf(r), r.via);
  const key = (rt.key ?? (() => instanceKeySync(rt.stateDir)))();
  if (!credential || !key) return patch(rt, operationId, { issue: "no_credential" });
  const client = new SharedLedgerFeatureProposalClient(credential, key, { fetch: rt.fetch, now: rt.now });
  try {
    // Only the caller that just staged a never-sent record submits directly; resume and every later attempt ask the
    // center first by operationId and resend (the same body) only if it has no record.
    let op = !opts.queryFirst && r.attempts === 0 && r.state === "unsynced" ? null : await client.status(scopeOf(r), operationId);
    if (op && op.state !== "conflict" && op.proposalDigest !== r.proposalDigest) return patch(rt, operationId, { state: "conflict", issue: null });
    if (!op) {
      if (r.expiresAt <= now) return patch(rt, operationId, { state: "expired", issue: null });
      await patch(rt, operationId, { attempts: r.attempts + 1 });
      op = await client.submit(r.proposal, now);
    }
    return patch(rt, operationId, fromOperation(op));
  } catch (e) {
    if (e instanceof FeatureProposalUnsupported) return patch(rt, operationId, { issue: "unsupported" });
    if (e instanceof FeatureProposalRejected) {
      const code = e.error?.code;
      if (e.status === 409 || code === "conflict") return patch(rt, operationId, { state: "conflict", issue: null });
      if (code === "expired") return patch(rt, operationId, { state: "expired", issue: null });
      if (e.status === 404) return patch(rt, operationId, { issue: "unsupported" }); // center without the proposal route
      if (e.status === 401 || e.status === 403) return patch(rt, operationId, { issue: "forbidden" });
      return patch(rt, operationId, { issue: "rejected_request" });
    }
    if (!(e instanceof SharedLedgerUnavailable)) console.warn("feature proposal sync failed"); // fixed text: errors may carry credentials
    return patch(rt, operationId, { issue: "unavailable" });
  }
}

/** Bridge start / periodic: every non-terminal record is checked against the center (first by operationId). */
export async function resumeProposals(rt: ProposalRuntime): Promise<PendingProposal[]> {
  const open = readPendingProposals(rt.stateDir).filter(r => !TERMINAL.includes(r.state));
  const out: PendingProposal[] = [];
  for (const r of open) out.push(await syncProposal(rt, r.operationId, { queryFirst: true }));
  return out;
}

/** Owner decision passthrough: one attempt, identity from the person credential, nothing journaled. */
export async function forwardDecision(rt: ProposalRuntime, scope: FeatureProposalScope, decision: unknown): Promise<ProposalOperation> {
  const credential = proposalCredential(rt, scope, "person");
  const key = (rt.key ?? (() => instanceKeySync(rt.stateDir)))();
  if (!credential || !key) throw new FeatureProposalRejected(403, null);
  return new SharedLedgerFeatureProposalClient(credential, key, { fetch: rt.fetch, now: rt.now }).decide(scope, decision as never);
}
