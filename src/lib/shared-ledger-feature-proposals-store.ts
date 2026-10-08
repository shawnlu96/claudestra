/** N7B pending-sync journal for feature proposals sent to the center: one 0600 file, read-modify-write under its lock.
 * It holds only the operation (operationId, the exact body and its digest, state, expiry); no local feature / DAG / card
 * is ever written for a bound team project. The body is kept so a resend carries the same digest.
 * Resume rule: ask the center first by operationId; when it has no record for us (403) resend the same body — the center
 * replays an operationId it has regardless of the clock. Changed content gets a new operationId (contentKey); owner
 * decisions are never stored or replayed here.
 * Terminal states are only the center's published / rejected / expired, plus a submit 409 code=conflict (same operationId,
 * other content). A pending proposal the center reports as conflict has drifted (the center row is still pending): it is
 * kept pending with issue "drift" and keeps being queried, never resent or re-approved automatically.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "./file-lock.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { instanceIdSync } from "./instance-id.js";
import { instanceKeySync, type InstanceKey } from "./instance-key.js";
import { resolveSharedLedgerCredential } from "./shared-ledger-mode.js";
import { SharedLedgerUnavailable } from "./shared-ledger-client-transport.js";
import { rebaseRevise } from "./shared-ledger-center-revise-base.js";
import { v2ObjectDigest } from "./shared-ledger-contract-v2-integrity.js";
import {
  FEATURE_PROPOSAL_LIMITS, PROPOSAL_OPERATION_STATES, proposalDigest, type FeatureProposal, type ProposalOperation,
} from "./shared-ledger-contract-v2-feature-proposals.js";
import {
  FeatureProposalRejected, FeatureProposalUnsupported, SharedLedgerFeatureProposalClient, type FeatureProposalScope, type ProposalList,
  type ProposalRecord,
} from "./shared-ledger-feature-proposals.js";

export type ProposalVia = "person" | "service";
type PendingState = "unsynced" | ProposalOperation["state"];
type PendingIssue = "unavailable" | "unsupported" | "no_credential" | "forbidden" | "rejected_request" | "drift" | null;
export interface PendingProposal {
  operationId: string; localProjectId: string; via: ProposalVia; contentKey: string;
  proposal: FeatureProposal; proposalDigest: string; state: PendingState; issue: PendingIssue;
  proposalId: string | null; featureId: string | null; version: number | null;
  attempts: number; expiresAt: number; createdAt: number; updatedAt: number;
  /** N7X3: a revise staged while the center base was unreadable; its proposal base is a placeholder, never sent (see syncOnce). */
  rebase?: { cancel: string[] };
}
interface PendingFile { schemaVersion: 1; operations: Record<string, PendingProposal> }
const FEATURE_PROPOSALS_FILE = "shared-feature-proposals.json";
export const PROPOSAL_DEFAULT_TTL_MS = 72 * 3_600_000;
/** conflict here is only ever set from a submit 409 code=conflict or a digest mismatch, never from a center operation state */
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

/** Everything that defines the proposal except operationId / expiresAt: equal content reuses the operation.
 * kind=revise (N7X3) carries its base (featureId / baseVersion / expectedRev / baseDigest), so a moved base is new content. */
type Draft<P> = P extends FeatureProposal ? Omit<P, "operationId" | "expiresAt"> : never;
export type ProposalDraft = Draft<FeatureProposal>;
const contentKeyOf = (draft: ProposalDraft, localProjectId: string, via: ProposalVia) => v2ObjectDigest({ draft, localProjectId, via });

/** Returns the one record for this content (concurrent equal calls share it); a new one gets a fresh operationId. */
export async function stageProposal(rt: ProposalRuntime, draft: ProposalDraft, localProjectId: string, via: ProposalVia,
  rebase?: PendingProposal["rebase"]): Promise<PendingProposal> {
  const contentKey = contentKeyOf(draft, localProjectId, via);
  return mutate(rt.stateDir, ops => {
    const now = rt.now();
    for (const [id, r] of Object.entries(ops)) if (TERMINAL.includes(r.state) && r.updatedAt + RETAIN_MS < now) delete ops[id];
    // A past-TTL unsynced record that may have been sent (attempts > 0) is still reused: sync asks the center first.
    const same = Object.values(ops).find(r => r.contentKey === contentKey && (r.state !== "unsynced" || r.attempts > 0 || r.expiresAt > now));
    if (same) return same;
    const ttl = Math.min(rt.ttlMs, FEATURE_PROPOSAL_LIMITS.maxTtlMs);
    let operationId = rt.newOperationId();
    while (ops[operationId]) operationId = rt.newOperationId();
    const proposal = { ...draft, operationId, expiresAt: now + ttl } as FeatureProposal;
    const record: PendingProposal = { operationId, localProjectId, via, contentKey, proposal, proposalDigest: rebase ? "" : proposalDigest(proposal),
      state: "unsynced", issue: null, proposalId: null, featureId: null, version: null, attempts: 0,
      expiresAt: proposal.expiresAt, createdAt: now, updatedAt: now, ...(rebase ? { rebase } : {}) };
    ops[operationId] = record;
    return record;
  });
}

/** N7X3: a journaled revise intent onto a fresh center read (shared-ledger-center-revise-base.ts, journal injected). */
export const rebaseProposal = (rt: ProposalRuntime, r: PendingProposal) => rebaseRevise(rt, r, { mutate, contentKeyOf });

async function patch(rt: ProposalRuntime, operationId: string, change: Partial<PendingProposal>): Promise<PendingProposal> {
  return mutate(rt.stateDir, ops => {
    const r = ops[operationId];
    if (!r) throw new Error("feature proposal record missing");
    ops[operationId] = { ...r, ...change, updatedAt: rt.now() };
    return ops[operationId]!;
  });
}
/** A center conflict on a record we own is drift: the center row is still pending, so locally it stays pending. */
const fromOperation = (op: ProposalOperation): Partial<PendingProposal> => op.state === "conflict"
  ? { state: "pending_approval", issue: "drift", proposalId: op.proposalId }
  : { state: op.state, issue: null, proposalId: op.proposalId, featureId: op.featureId, version: op.version };
/** 409 code=replayed is the center refusing a reused nonce, not an outcome: one more attempt (fresh nonce, same body). */
async function onceMoreIfReplayed<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); } catch (e) {
    if (e instanceof FeatureProposalRejected && e.status === 409 && e.error?.code === "replayed") return call();
    throw e;
  }
}

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
  let r = readPendingProposals(rt.stateDir).find(x => x.operationId === operationId);
  if (!r) throw new Error("feature proposal record missing");
  if (TERMINAL.includes(r.state)) return r;
  const now = rt.now();
  if (r.rebase && r.expiresAt > now) { // N7X3: read the center base fresh first; still unreadable → stays a pending intent
    const based = (await rebaseProposal(rt, r)).record;
    if (based.operationId !== operationId) return syncProposal(rt, based.operationId, opts); // same content already journaled
    if (based.rebase || TERMINAL.includes(based.state)) return based;
    r = based;
  }
  // Never sent (attempts is bumped before any submit) → the center cannot have it, TTL alone decides. Once it may have
  // been sent, only the center decides: it replays a known operationId past expiresAt, so a lost reply may still be published.
  if (r.state === "unsynced" && r.attempts === 0 && r.expiresAt <= now) return patch(rt, operationId, { state: "expired", issue: null });
  const credential = proposalCredential(rt, scopeOf(r), r.via);
  const key = (rt.key ?? (() => instanceKeySync(rt.stateDir)))();
  if (!credential || !key) return patch(rt, operationId, { issue: "no_credential" });
  const client = new SharedLedgerFeatureProposalClient(credential, key, { fetch: rt.fetch, now: rt.now });
  let submitted = false;
  try {
    // Only the caller that just staged a never-sent record submits directly; resume and every later attempt ask the
    // center first by operationId and resend (the same body) only if it has no record for us.
    let rec: ProposalRecord | null = !opts.queryFirst && r.attempts === 0 && r.state === "unsynced" ? null
      : await onceMoreIfReplayed(() => client.status(scopeOf(r), operationId));
    if (rec && rec.operation.proposalDigest !== r.proposalDigest) return patch(rt, operationId, { state: "conflict", issue: null });
    if (!rec) {
      await patch(rt, operationId, { attempts: r.attempts + 1 });
      submitted = true;
      rec = await onceMoreIfReplayed(() => client.submit(r.proposal, now, { resend: r.attempts > 0 || r.expiresAt <= now }));
    }
    return patch(rt, operationId, fromOperation(rec.operation));
  } catch (e) {
    if (e instanceof FeatureProposalUnsupported) return patch(rt, operationId, { issue: "unsupported" });
    if (e instanceof FeatureProposalRejected) {
      const code = e.error?.code;
      // Only a submit 409 conflict (same operationId, other content) is final; a new operationId is needed to propose again.
      if (submitted && e.status === 409 && code === "conflict") return patch(rt, operationId, { state: "conflict", issue: null });
      // The center refuses a first submission past expiresAt as invalid_field; it would have replayed one it had.
      if (submitted && e.status === 400 && code === "invalid_field" && r.expiresAt <= now) return patch(rt, operationId, { state: "expired", issue: null });
      if (e.status === 404) return patch(rt, operationId, { issue: "unsupported" }); // center without the proposal route
      // 403 also covers an expired credential, 401 a bad signature: recoverable, never a proposal outcome
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

function personClient(rt: ProposalRuntime, scope: FeatureProposalScope) {
  const credential = proposalCredential(rt, scope, "person");
  const key = (rt.key ?? (() => instanceKeySync(rt.stateDir)))();
  if (!credential || !key) throw new FeatureProposalRejected(403, null);
  return { credential, client: new SharedLedgerFeatureProposalClient(credential, key, { fetch: rt.fetch, now: rt.now }) };
}

/** Owner decision passthrough: one attempt, identity from the person credential, nothing journaled. */
export async function forwardDecision(rt: ProposalRuntime, scope: FeatureProposalScope, proposalId: string, decision: unknown): Promise<ProposalRecord> {
  return personClient(rt, scope).client.decide(scope, proposalId, decision as never);
}

/** Owner review list straight from the center (person credential, nothing journaled); selfPersonId marks own proposals. */
export async function listCenterProposals(rt: ProposalRuntime, scope: FeatureProposalScope): Promise<ProposalList & { selfPersonId: string }> {
  const { credential, client } = personClient(rt, scope);
  return { ...await client.listProject(scope), selfPersonId: credential.personId };
}
