/**
 * N7X1 center claims (认领记录): one row per center bind operation the home instance sent for a replica's node.
 * start_node (N7X2) writes `pending` before it asks the center, then `committed` / `conflict` / `orphan`; only a
 * `committed` row whose feature, node key and card id all match opens the start gates (shared-ledger-gate.ts
 * requireSharedLedgerStart). File: shared-center-binds.json, 0600, lock + tmp/rename like the other shared ledger state.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "./file-lock.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { STATE_DIR } from "./paths.js";

export type CenterClaimState = "pending" | "committed" | "conflict" | "orphan";
export interface CenterClaim {
  /** Center operationId of the bind; one row per op. */
  op: string;
  /** Exact body sent (FeatureHomeBind); a resend must carry the same digest. */
  body: Record<string, unknown>;
  digest: string;
  localFeatureId: string;
  key: string;
  taskId: string;
  state: CenterClaimState;
}
interface ClaimFile { claims: CenterClaim[] }

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const STATES: readonly string[] = ["pending", "committed", "conflict", "orphan"];
/** pending may settle any way; committed may only be orphaned; conflict / orphan are final. */
const NEXT: Record<CenterClaimState, readonly CenterClaimState[]> = {
  pending: ["pending", "committed", "conflict", "orphan"], committed: ["committed", "orphan"], conflict: ["conflict"], orphan: ["orphan"],
};
export const centerClaimsPath = (dir = STATE_DIR) => join(dir, "shared-center-binds.json");

function validClaim(c: unknown): c is CenterClaim {
  if (!c || typeof c !== "object" || Array.isArray(c)) return false;
  const r = c as CenterClaim;
  return [r.op, r.localFeatureId, r.key, r.taskId].every((v) => typeof v === "string" && ID.test(v))
    && typeof r.digest === "string" && /^[0-9a-f]{64}$/.test(r.digest) && STATES.includes(r.state)
    && !!r.body && typeof r.body === "object" && !Array.isArray(r.body);
}
function claimFile(value: unknown): value is ClaimFile {
  if (!value || typeof value !== "object" || !Array.isArray((value as ClaimFile).claims)) return false;
  const claims = (value as ClaimFile).claims;
  return claims.every(validClaim) && new Set(claims.map((c) => c.op)).size === claims.length;
}

/** Corrupt file throws (callers fail closed); missing = no claims. */
export function readCenterClaims(dir = STATE_DIR): CenterClaim[] {
  const state = readJsonStateSync(centerClaimsPath(dir), claimFile);
  if (state.status === "corrupt") throw new Error("shared center claims invalid");
  return state.status === "missing" ? [] : structuredClone((state.data as ClaimFile).claims);
}

async function updateCenterClaims<T>(dir: string, mutate: (claims: CenterClaim[]) => T): Promise<T> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = centerClaimsPath(dir), lock = await acquireLock(`${path}.lock`);
  if (!lock) throw new Error("shared center claims lock unavailable");
  try {
    const state: ClaimFile = { claims: readCenterClaims(dir) };
    const out = mutate(state.claims);
    if (!claimFile(state)) throw new Error("shared center claims invalid");
    writeJsonAtomicSync(path, state, { mode: 0o600, commitIf: lock.held });
    return out;
  } finally { lock.release(); }
}

/**
 * Records a claim (normally state=pending before the center request). Same op + same digest returns the stored row
 * unchanged (a retry); same op + another digest, or another live (pending / committed) claim on the same feature node
 * or the same card, is refused.
 */
export async function putCenterClaim(claim: CenterClaim, dir = STATE_DIR): Promise<CenterClaim> {
  if (!validClaim(claim)) throw new Error("invalid center claim");
  return updateCenterClaims(dir, (claims) => {
    const prior = claims.find((c) => c.op === claim.op);
    if (prior) {
      if (prior.digest !== claim.digest || prior.localFeatureId !== claim.localFeatureId || prior.key !== claim.key || prior.taskId !== claim.taskId) {
        throw new Error("center claim op already recorded with other content");
      }
      return structuredClone(prior);
    }
    const live = claims.find((c) => (c.state === "pending" || c.state === "committed")
      && ((c.localFeatureId === claim.localFeatureId && c.key === claim.key) || c.taskId === claim.taskId));
    if (live) throw new Error("another live center claim holds this node or card");
    claims.push(structuredClone(claim));
    return structuredClone(claim);
  });
}

/** Moves one claim along pending → committed | conflict | orphan, committed → orphan. Unknown op or a backwards move throws. */
export async function setCenterClaimState(op: string, state: CenterClaimState, dir = STATE_DIR): Promise<CenterClaim> {
  if (!STATES.includes(state)) throw new Error("invalid center claim state");
  return updateCenterClaims(dir, (claims) => {
    const claim = claims.find((c) => c.op === op);
    if (!claim) throw new Error("center claim not found");
    if (!NEXT[claim.state].includes(state)) throw new Error(`center claim cannot move ${claim.state} → ${state}`);
    claim.state = state;
    return structuredClone(claim);
  });
}

export function findCenterClaim(op: string, dir = STATE_DIR): CenterClaim | null {
  return readCenterClaims(dir).find((c) => c.op === op) ?? null;
}

/** The start-gate predicate: a committed claim naming exactly this feature, node and card. Throws on a corrupt file. */
export function centerClaimCommitted(localFeatureId: string, key: string, taskId: string, dir = STATE_DIR): boolean {
  return readCenterClaims(dir).some((c) => c.state === "committed" && c.localFeatureId === localFeatureId && c.key === key && c.taskId === taskId);
}

/** task-new has a card id but no node: the committed claim for (feature, card), if any. */
export function committedCenterClaimFor(localFeatureId: string, taskId: string, dir = STATE_DIR): CenterClaim | null {
  return readCenterClaims(dir).find((c) => c.state === "committed" && c.localFeatureId === localFeatureId && c.taskId === taskId) ?? null;
}
