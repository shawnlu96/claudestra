/** Runtime admission uses the per-project family cap, while retaining quota checks and the renewable creation lock. */
import { Database } from "bun:sqlite";
import { readSchedulerConfig, SCHEDULER_CONFIG_PATH } from "./scheduler-config.js";
import { LEDGER_PATH } from "./ledger-store.js";
import { localAgentPool } from "./scheduler-agent-pool-ledger.js";
import { readInventoryQuota, type InventoryQuota } from "./ai-quota.js";
import type { AgentLimits } from "./scheduler-agent-pool-config.js";
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { CodexSlotOptions, SlotWait } from "./scheduler-local-runtime-slots.js";

export function configuredAgentLimits(opts: CodexSlotOptions): AgentLimits | null {
  return opts.project ? readSchedulerConfig(opts.configPath ?? SCHEDULER_CONFIG_PATH).projects[opts.project]?.agents ?? null : null;
}

export function runtimePoolWait(opts: CodexSlotOptions, limits: AgentLimits): SlotWait | null {
  const db = new Database(opts.ledgerPath ?? LEDGER_PATH, { readonly: true });
  try {
    const family = opts.family ?? "codex";
    const load = localAgentPool(db, opts.project!, limits, opts.taskId);
    return load.running[family] >= load.totals[family] ? { kind: "wait", reason: `等 ${family} 空位` } : null;
  } finally { db.close(); }
}

export function poolAuthorRuntime(project: string, limits: AgentLimits, ledgerPath = LEDGER_PATH): AuthorFamily {
  const db = new Database(ledgerPath, { readonly: true });
  try {
    const load = localAgentPool(db, project, limits);
    return load.running.claude < load.totals.claude ? "claude" : "codex";
  } finally { db.close(); }
}

export async function poolQuotaWait(family: AuthorFamily, read = async (): Promise<InventoryQuota> => (await readInventoryQuota())[family],
  now = Date.now()): Promise<SlotWait | null> {
  let q: InventoryQuota;
  try { q = await read(); }
  catch (e) {
    // Quota observations are optional just as on the legacy path; runtime quota failures still pause and report.
    console.error(`[scheduler-agent-pool] ${family} 额度读不到：${(e as Error).message}`); return null;
  }
  if (q.status !== "known") return null;
  const over = q.windows.find((w) => (w.kind === "weekly" || w.kind === "weekly_scoped") && !w.resetPassed &&
    (w.resetsAtMs === null || w.resetsAtMs > now) && w.usedPct !== null && w.usedPct >= 85);
  return over ? { kind: "wait", reason: `等 ${family} 空位（周额度已到85%）` } : null;
}
