/** Canonical task-row writer, extracted unchanged so deliver can add dispute validation within its transaction. */
import type { Database } from "bun:sqlite";
import { toColumn, type WriteCtx } from "./ledger-checks.js";
import type { LedgerTask } from "./ledger-stages.js";

export function updateTask(db: Database, ctx: WriteCtx, cur: LedgerTask, patch: Record<string, unknown>): number {
  const cols = Object.keys(patch);
  const rev = cur.rev + 1;
  db.prepare(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(", ")}, rev = ?, updatedAt = ? WHERE id = ?`).run(
    ...(cols.map((c) => toColumn(c, patch[c])) as string[]),
    rev,
    ctx.now ?? Date.now(),
    cur.id,
  );
  return rev;
}
