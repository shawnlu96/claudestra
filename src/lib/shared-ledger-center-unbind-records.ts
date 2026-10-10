/**
 * N7X5 unbind records (撤销记录): one row per center unbind operation `ledger center-replica unbind` sent for a replica's node.
 * Written `pending` before the POST, then `committed` / `conflict` / `unsupported`; a pending row is asked by op (GET) before
 * anything is resent. File: shared-center-unbinds.json, 0600, lock + tmp/rename like the claims file (shared-ledger-center-claims.ts).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "./file-lock.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { STATE_DIR } from "./paths.js";
import type { CenterClaim } from "./shared-ledger-center-claims.js";

export type CenterUnbindState = "pending" | "committed" | "conflict" | "unsupported";
/** Same row shape as a claim: op = the unbind's operationId, body = the exact FeatureHomeUnbind sent (a resend carries the same
 * digest), taskId = the center task id the node was bound to (the body's taskId), orphans = the ops of the node's orphan claims
 * this unbind revokes (taken when the row is written; committed releases exactly these, never a later claim's orphan),
 * count = how many consecutive conflicts of this node the conflict row stands for (missing = 1). */
export interface CenterUnbind extends Omit<CenterClaim, "state"> { state: CenterUnbindState; orphans?: string[]; count?: number }
interface UnbindFile { unbinds: CenterUnbind[] }

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const STATES: readonly string[] = ["pending", "committed", "conflict", "unsupported"];
export const centerUnbindsPath = (dir = STATE_DIR) => join(dir, "shared-center-unbinds.json");

function validUnbind(u: unknown): u is CenterUnbind {
  if (!u || typeof u !== "object" || Array.isArray(u)) return false;
  const r = u as CenterUnbind;
  return [r.op, r.localFeatureId, r.key, r.taskId].every((v) => typeof v === "string" && ID.test(v))
 && (r.count === undefined || (Number.isSafeInteger(r.count) && r.count >= 1))
    && (r.orphans === undefined || (Array.isArray(r.orphans) && r.orphans.every((v) => typeof v === "string" && ID.test(v))))
    && typeof r.digest === "string" && /^[0-9a-f]{64}$/.test(r.digest) && STATES.includes(r.state)
    && !!r.body && typeof r.body === "object" && !Array.isArray(r.body);
}
function unbindFile(value: unknown): value is UnbindFile {
  if (!value || typeof value !== "object" || !Array.isArray((value as UnbindFile).unbinds)) return false;
  const rows = (value as UnbindFile).unbinds;
  return rows.every(validUnbind) && new Set(rows.map((u) => u.op)).size === rows.length;
}

/** Corrupt file throws (callers fail closed); missing = no records. */
export function readCenterUnbinds(dir = STATE_DIR): CenterUnbind[] {
  const state = readJsonStateSync(centerUnbindsPath(dir), unbindFile);
  if (state.status === "corrupt") throw new Error("shared center unbinds invalid");
  return state.status === "missing" ? [] : structuredClone((state.data as UnbindFile).unbinds);
}

async function updateCenterUnbinds<T>(dir: string, mutate: (rows: CenterUnbind[]) => T): Promise<T> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = centerUnbindsPath(dir), lock = await acquireLock(`${path}.lock`);
  if (!lock) throw new Error("shared center unbinds lock unavailable");
  try {
    const state: UnbindFile = { unbinds: readCenterUnbinds(dir) };
    const out = mutate(state.unbinds);
    if (!unbindFile(state)) throw new Error("shared center unbinds invalid");
    writeJsonAtomicSync(path, state, { mode: 0o600, commitIf: lock.held });
    return out;
  } finally { lock.release(); }
}

/** Records a new pending row. An existing op, or another pending row on the same feature node, is refused. */
export async function putCenterUnbind(row: CenterUnbind, dir = STATE_DIR): Promise<CenterUnbind> {
  if (!validUnbind(row) || row.state !== "pending") throw new Error("invalid center unbind");
  return updateCenterUnbinds(dir, (rows) => {
    if (rows.some((u) => u.op === row.op)) throw new Error("center unbind op already recorded");
    if (rows.some((u) => u.state === "pending" && u.localFeatureId === row.localFeatureId && u.key === row.key)) {
      throw new Error("another pending center unbind holds this node");
    }
    rows.push(structuredClone(row));
    return structuredClone(row);
  });
}

/** pending → committed | conflict | unsupported; settled rows are final. Unknown op or a settled row throws. */
export async function settleCenterUnbind(op: string, state: Exclude<CenterUnbindState, "pending">, dir = STATE_DIR): Promise<CenterUnbind> {
  if (!STATES.includes(state) || state === ("pending" as string)) throw new Error("invalid center unbind state");
  return updateCenterUnbinds(dir, (rows) => {
    const row = rows.find((u) => u.op === op);
    if (!row) throw new Error("center unbind not found");
    if (row.state !== "pending" && row.state !== state) throw new Error(`center unbind cannot move ${row.state} → ${state}`);
    row.state = state;
    return structuredClone(row);
  });
}

/** pending → conflict, except when the node's previous row is already a conflict: that row counts one more and the pending row
 * goes (the center rejected its op for good), so repeated conflicts of a node never pile up rows. Returns the conflict row. */
export async function settleCenterUnbindConflict(op: string, dir = STATE_DIR): Promise<CenterUnbind> {
  return updateCenterUnbinds(dir, (rows) => {
    const at = rows.findIndex((u) => u.op === op), row = rows[at];
    if (!row) throw new Error("center unbind not found");
    if (row.state !== "pending") throw new Error(`center unbind cannot move ${row.state} → conflict`);
    const prev = rows.slice(0, at).findLast((u) => u.localFeatureId === row.localFeatureId && u.key === row.key);
    if (prev?.state === "conflict") {
      rows.splice(at, 1);
      prev.count = (prev.count ?? 1) + 1;
      return structuredClone(prev);
    }
    row.state = "conflict";
    row.count = 1;
    return structuredClone(row);
  });
}
