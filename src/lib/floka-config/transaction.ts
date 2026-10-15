import { dirname, isAbsolute, relative } from "node:path";
import { realpathSync } from "node:fs";
import { runTransaction } from "../floka-migration/transaction/executor.js";
import { loadJournal, validTxId } from "../floka-migration/transaction/journal.js";
import type { TxReport, TxStep } from "../floka-migration/transaction/types.js";
import { object, renameMode } from "./values.js";

export interface ItemOptions {
  config: unknown;
  txId: string;
  journalDir: string;
  /** SERVICES supplies a real grant consumer. Missing/false never authorizes an on operation. */
  authorize?: (item: "runtime" | "config", txId: string) => Promise<boolean>;
  crashAt?: (point: string) => void;
}

/** Journal diagnostics must reflect the current disk owner, never the executor's stale memory. */
export async function runItem(item: "runtime" | "config", o: ItemOptions, step: TxStep<unknown>): Promise<TxReport> {
  const mode = renameMode(object(object(o.config).rename)[item]);
  if (mode === "on" && !(await o.authorize?.(item, o.txId))) {
    return { txId: o.txId, mode, status: "refused", steps: [], error: `rename.${item} requires an explicit maintenance grant` };
  }
  const report = await runTransaction({ txId: o.txId, mode, items: { [step.item]: mode }, steps: [step], adapter: null,
    stateDir: o.journalDir, crashAt: o.crashAt });
  if (mode !== "on" || !validTxId(o.txId)) return report;
  const disk = await loadJournal(o.journalDir, o.txId, [step.id]);
  if (disk.kind === "bad") return { ...report, status: "refused", steps: [], error: disk.error };
  if (disk.kind !== "ok") return { ...report, steps: [] };
  const j = disk.journal;
  return { ...report, steps: j.steps.map(s => ({ id: s.id, item: s.item, mode, state: s.state, ...(s.error ? { error: s.error } : {}) })),
    status: j.status === "running" || j.status === "rolling_back" ? "refused" : j.status,
    ...(j.failure ? { failedStep: j.failure.step, error: j.failure.error } : {}) };
}

/** Refuse storing locks/journals inside any directory that this item manages. */
export function journalOutside(journal: string, roots: string[]): void {
  if (!isAbsolute(journal) || roots.some(p => !isAbsolute(p))) throw new Error("migration paths must be absolute");
  const canonical = (path: string): string => {
    try { return realpathSync(path); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = dirname(path);
      return parent === path ? path : canonical(parent) + "/" + relative(parent, path);
    }
  };
  const j = canonical(journal);
  if (roots.some(root => { const r = relative(canonical(root), j); return r === "" || !r.startsWith("..") && !isAbsolute(r); })) {
    throw new Error("migration journal must be outside managed roots");
  }
}
