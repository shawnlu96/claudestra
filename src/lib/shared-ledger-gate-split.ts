import type { SplitPlan } from "./ledger-feature-split-plan.js";
import { requireLocalSharedLedgerPlanning } from "./shared-ledger-gate.js";

/** Split SQL touches every group and dependency endpoint, including targets that bypass feature creation. */
export function requireLocalSharedLedgerSplit(plan: SplitPlan): void {
  const ids = new Set([plan.source.id, ...plan.groups.map(g => g.id), ...plan.deps.flatMap(d => [d.from, d.to])]);
  for (const id of ids) requireLocalSharedLedgerPlanning(id);
}
