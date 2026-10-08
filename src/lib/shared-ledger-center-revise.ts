/**
 * N7X3 rewrite of a center replica → kind=revise feature proposal (阶段一). manager `ledger dag-rewrite` asks this first,
 * so rewrite_dag, plan_feature on an existing feature and the CLI all land here; a non-replica gets null (old path).
 * - Never writes the local ledger: the replica only moves when the center publishes and the next replica sync replays it.
 * - Refused locally, before any request: scopeChange, and changing / removing / cancelling a bound node.
 * - featureId / baseVersion / expectedRev / baseDigest / title / home come from a fresh center read, never the replica cache;
 *   baseDigest is the shared featureBaseDigest (centerReplicaBaseDigest). Local-only node fields are dropped.
 * - The intent (nodes, reason, cancels) is journaled first with a placeholder base (`rebase`); rebaseRevise reads the center
 *   and turns it into the real proposal. Center unreachable → it stays a pending-sync intent, and resume (the store's
 *   syncOnce) rebases it on a fresh read and re-checks center bindings / home before anything is sent.
 * - Journal, resend and drift are N7B's (shared-ledger-feature-proposals-store.ts): equal content reuses the operationId,
 *   a moved base or other content gets a new one; a drifted proposal is kept and queried, never resent automatically.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { instanceKeySync } from "./instance-key.js";
import { getDagVersion, type Feature } from "./ledger-feature.js";
import { requireManager } from "./ledger-feature-write.js";
import { LedgerError } from "./ledger-store.js";
import { STATE_DIR } from "./paths.js";
import { FEATURE_PROPOSAL_SCHEMA_VERSION } from "./shared-ledger-contract-v2-feature-proposals.js";
import { checkReplicaNodes, replicaBoundNodes, type CenterNode } from "./shared-ledger-center-replica-write.js";
import { keepBound, REVISE_TERMINAL, REVISE_TEXT } from "./shared-ledger-center-revise-base.js";
import {
  PROPOSAL_DEFAULT_TTL_MS, rebaseProposal, stageProposal, syncProposal, type PendingProposal, type ProposalRuntime,
} from "./shared-ledger-feature-proposals-store.js";
import { resolveMirrorCredential } from "./shared-ledger-mirror.js";
import { readSharedLedgerMode } from "./shared-ledger-mode.js";

export { REVISE_TEXT };

let runtime: Partial<ProposalRuntime> | null = null;
/** Test injection (temp state dir, clock, instance id, fake center fetch); undefined goes back to live. */
export function configureCenterRevise(rt: Partial<ProposalRuntime> | undefined): void { runtime = rt ?? null; }
const rt = (): ProposalRuntime => ({ stateDir: STATE_DIR, now: Date.now, newOperationId: () => `op-${randomUUID()}`, ttlMs: PROPOSAL_DEFAULT_TTL_MS, ...runtime });

export interface ReviseInput {
  rev: number; nodes: unknown; reason: string; cancel: ReadonlyMap<string, string>; scope: boolean; actor: string;
}

/** Center wire node: only the five planning fields, whatever local fields (taskId, status, …) the caller carried. */
function wireNodes(nodes: unknown): CenterNode[] {
  if (!Array.isArray(nodes)) throw new LedgerError("invalid", REVISE_TEXT.invalid);
  return nodes.map((n) => {
    const o = (n ?? {}) as Record<string, unknown>, list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    if (typeof o.key !== "string") throw new LedgerError("invalid", REVISE_TEXT.invalid);
    return { key: o.key, oneLine: typeof o.oneLine === "string" ? o.oneLine : "", deps: list(o.deps), fileGlobs: list(o.fileGlobs), estimate: typeof o.estimate === "string" ? o.estimate : "" };
  });
}
function outcome(r: PendingProposal) {
  const base = { operationId: r.operationId, state: r.state, proposalId: r.proposalId, kind: "revise" as const };
  const ok = (message: string) => ({ ok: true, applied: false, version: null, proposal: base, next: message, message });
  const no = (code: string, error: string) => ({ ok: false, code, error, proposal: base });
  if (r.state === "published") return ok(REVISE_TEXT.published);
  if (r.state === "rejected" || r.state === "expired" || r.state === "conflict") return no(`proposal_${r.state}`, REVISE_TEXT[r.state]);
  if (r.issue === "drift") return no("proposal_drift", REVISE_TEXT.drift);
  if (r.issue === "unsupported") return no("unsupported", REVISE_TEXT.unsupported);
  if (r.issue === "no_credential") return no("forbidden", REVISE_TEXT.no_credential);
  if (r.issue === "forbidden") return no("forbidden", REVISE_TEXT.forbidden);
  if (r.issue === null && (r.state === "pending_approval" || r.state === "approved")) return ok(REVISE_TEXT[r.state]);
  return no("pending_sync", `${REVISE_TEXT.pending_sync}（operationId ${r.operationId}）`);
}

/** manager dagRewrite hook: null = not a center replica (old path); otherwise the revise outcome. Zero local ledger writes. */
export async function reviseCenterReplica(db: Database, f: Feature, input: ReviseInput): Promise<Record<string, unknown> | null> {
  const r = rt();
  const planned = readSharedLedgerMode(f.id, r.stateDir).centerPlanned;
  if (!planned) return null;
  requireManager(db, input.actor, f.project);
  if (f.rev !== input.rev) throw new LedgerError("conflict", `feature ${f.id} 已被改过：当前 rev ${f.rev}，你带的是 ${input.rev}`, { rev: f.rev });
  // Local refusals first: nothing is sent or journaled for these.
  if (input.scope) throw new LedgerError("forbidden", REVISE_TEXT.scope);
  const cur = f.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
  const local = new Map((cur?.nodes ?? []).map((n) => [n.key, n] as const)), bound = replicaBoundNodes(db, f);
  const nodes = keepBound(wireNodes(input.nodes), local, bound.keys(), input.cancel);
  checkReplicaNodes(db, { localFeatureId: f.id, localProject: f.project, nodes }, bound); // the replica must be able to replay it
  const scope = { centerId: planned.centerId, teamId: planned.teamId, projectId: planned.projectId };
  if (!resolveMirrorCredential(scope, r.stateDir) || !(r.key ?? (() => instanceKeySync(r.stateDir)))()) throw new LedgerError("forbidden", REVISE_TEXT.no_credential);
  // Intent first (placeholder base, never sent), then the base from a fresh center read.
  const intent = await stageProposal(r, {
    schemaVersion: FEATURE_PROPOSAL_SCHEMA_VERSION, ...scope, kind: "revise", featureId: planned.centerFeatureId, baseVersion: 0, expectedRev: 0,
    baseDigest: "", title: "", description: "", ownerWords: input.reason, nodes, homeInstanceId: "",
  }, f.project, "service", { cancel: [...input.cancel.keys()].sort() });
  const { record, refusal } = await rebaseProposal(r, intent);
  if (refusal) throw refusal;
  return outcome(record.rebase || REVISE_TERMINAL.includes(record.state) ? record : await syncProposal(r, record.operationId));
}
