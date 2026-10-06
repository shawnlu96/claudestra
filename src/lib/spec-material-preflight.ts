/**
 * dispatch-recovery-SPECG1, the writer's side: createTask / setTask call runSpecPreflight inside their transaction. The check
 * itself (lend write-order builder, peer gate, RecoveryPolicyPort) lives in spec-material-preflight-gate.ts, which imports the
 * ledger writer, so it is injected here at the process edge (the `ledger` CLI loads it) instead of imported: a runtime import
 * would cycle. A process that never armed it answers "unavailable" (unarmed): never a pass, and never read as the
 * user's off; every process entry that writes the ledger arms it (tests/spec-material-preflight-entries.test.ts). tests/spec-material-preflight*.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import type { LedgerTask } from "./ledger-stages.js";

export type PreflightCategory = "secret" | "sensitive_id" | "oversize" | "too_many" | "head" | "file_scope" | "format" | "other";
export type MaterialKind = "spec" | "file_scope" | "restate" | "order_text";
export interface PreflightReceipt { project: string; taskId: string; specRev: number; ruleVersion: string; digest: string }
export type PreflightResult =
  | { status: "skipped"; reason: string }
  | { status: "unavailable"; reason: "no_spec" | "error" | "unarmed"; ruleVersion: string }
  | { status: "pass"; receipt: PreflightReceipt }
  | { status: "blocked"; category: PreflightCategory; material: number | null; kind: MaterialKind; ruleVersion: string; digest: string; advice: string };

type Preflight = (db: Database, ctx: WriteCtx, before: LedgerTask | null, after: LedgerTask) => PreflightResult;
let armed: Preflight | null = null;

/** The gate module arms the hook; returns the previous one (tests restore it). */
export function registerSpecPreflight(fn: Preflight | null): Preflight | null {
  const prev = armed;
  armed = fn;
  return prev;
}

/** Called by the writer after the row is written, inside its transaction; a throw rolls the write back. */
export function runSpecPreflight(db: Database, ctx: WriteCtx, before: LedgerTask | null, after: LedgerTask): PreflightResult {
  return armed ? armed(db, ctx, before, after) : { status: "unavailable", reason: "unarmed", ruleVersion: "" };
}
