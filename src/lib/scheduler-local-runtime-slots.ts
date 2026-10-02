import { configuredAgentLimits, runtimePoolWait, poolQuotaWait } from "./scheduler-agent-pool-runtime.js";
/** Authors and reviewers serialize count→create under one renewable, fail-closed machine lock. */
import { codexQuotaWait, type CodexQuotaReader } from "./scheduler-local-runtime-quota.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { acquireLock, type LockHandle } from "./file-lock.js";
import { statePath } from "./paths.js";
import { REGISTRY_PATH, normalizeRegistryAgents, type RegistryAgent } from "./registry.js";

import { workingCodexAgents } from "./scheduler-local-runtime-slots-ledger.js";

const LOCAL_CODEX_LIMIT = 6;
export interface CodexSlotOptions {
  registryPath?: string; ledgerPath?: string; lockPath?: string; codexQuota?: CodexQuotaReader; checkQuota?: boolean;
  project?: string; taskId?: string; family?: "claude" | "codex"; configPath?: string;
}
const owned = new AsyncLocalStorage<LockHandle>();
export type SlotWait = { kind: "wait"; reason: string; quota?: { id: string; usedPct: number; resetsAtMs: number | null } };
const wait = (reason: string): SlotWait => ({ kind: "wait", reason });

// Creating reservations precede runtime assignment; only a proven Claude/Pi reservation can leave a Codex slot free.
function codexSessionCount(rows: RegistryAgent[], working: Set<string>): number {
  return rows.filter((r) => (r.status === "creating" && r.runtime !== "claude-code" && r.runtime !== "pi")
    || (working.has(r.name) && r.runtime === "codex" && (r.status === "active" || r.status === undefined))).length;
}

function count(path: string, ledgerPath?: string): number {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw?.agents || typeof raw.agents !== "object" || Array.isArray(raw.agents)
    || Object.values(raw.agents).some((r) => !r || typeof r !== "object" || Array.isArray(r))) throw new Error("invalid registry agents");
  return codexSessionCount(normalizeRegistryAgents(raw), workingCodexAgents(ledgerPath));
}

export async function withCodexSlot<T>(run: () => Promise<T>, opts: CodexSlotOptions = {}): Promise<T | SlotWait> {
  const inherited = owned.getStore();
  if (inherited) return inherited.held() ? run() : wait("Codex 全机槽锁已失租，等待重试");
  const lock = await acquireLock(opts.lockPath ?? statePath("scheduler-local-codex.lock"), 0);
  if (!lock) return wait("Codex 全机槽正在创建会话，等待重试");
  try {
    const limits = configuredAgentLimits(opts);
    let n: number;
    try { if (limits) {
      const blocked = runtimePoolWait(opts, limits);
      if (blocked) return blocked;
      n = 0;
    } else n = count(opts.registryPath ?? REGISTRY_PATH, opts.ledgerPath); }
    catch (e) { return wait(`无法核实 Codex 全机会话数，等待：${(e as Error).message}`); }
    if (n >= LOCAL_CODEX_LIMIT) return wait(`Codex 全机会话已达 ${LOCAL_CODEX_LIMIT}，等待空槽`);
    const quotaWait = limits ? await poolQuotaWait(opts.family ?? "codex", opts.family === "claude" ? undefined : opts.codexQuota, undefined, opts)
      : opts.checkQuota ? await codexQuotaWait(opts.codexQuota, undefined, opts) : null;
    if (quotaWait) return quotaWait;
    if (!lock.held()) return wait("Codex 全机槽锁已失租，等待重试");
    return await owned.run(lock, run);
  } finally { lock.release(); }
}

/** Every manager create checks ownership again after any awaited worktree / ledger operation. */
export function codexSlotHeld(): boolean { return owned.getStore()?.held() === true; }
