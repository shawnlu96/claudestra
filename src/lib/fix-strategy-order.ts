/** Every local order path carries the same repair/dispute rules; long original material travels in a durable artifact. */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { LedgerTask } from "./ledger-stages.js";
import { listEvents } from "./ledger-store.js";
import { DISPUTE_RULE, FIX_STRATEGY_RULE } from "./fix-strategy.js";

export function convergenceOrderLines(db: Database | undefined, task: LedgerTask): string[] {
  const material = db && listEvents(db, { project: task.project, target: task.id }).findLast((e) => e.kind === "scheduler" &&
    e.data.op === "fix_strategy" && e.data.specRev === task.specRev && e.data.round === task.round)?.data.material;
  return [DISPUTE_RULE, FIX_STRATEGY_RULE, ...(typeof material === "string" ? [`历轮报告原文、修复 diff 摘要、复现 probe：${material}`] : [])];
}

/** The existing remote order's spec input carries the material itself: a lender cannot open this machine's artifact path. */
export function convergenceSpec(db: Database, task: LedgerTask, spec: string | null): string | null {
  if (task.stage !== "fix") return spec;
  const event = listEvents(db, { project: task.project, target: task.id }).findLast((e) => e.data.op === "fix_strategy" &&
    e.data.specRev === task.specRev && e.data.round === task.round);
  if (typeof event?.data.material !== "string") return spec;
  return `${spec ?? ""}\n\n${readFileSync(event.data.material, "utf8")}`;
}
