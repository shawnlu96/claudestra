/** Authors and reviewers serialize count→create under one renewable, fail-closed machine lock. */
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { acquireLock, type LockHandle } from "./file-lock.js";
import { statePath } from "./paths.js";
import { REGISTRY_PATH, normalizeRegistryAgents, type RegistryAgent } from "./registry.js";

const LOCAL_CODEX_LIMIT = 6;
export interface CodexSlotOptions { registryPath?: string; lockPath?: string }
const owned = new AsyncLocalStorage<LockHandle>();
export type SlotWait = { kind: "wait"; reason: string };
const wait = (reason: string): SlotWait => ({ kind: "wait", reason });

function codexSessionCount(rows: RegistryAgent[]): number {
  return rows.filter((r) => r.runtime === "codex" && (r.status === "active" || r.status === undefined)).length;
}

function count(path: string): number {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw?.agents || typeof raw.agents !== "object" || Array.isArray(raw.agents)
    || Object.values(raw.agents).some((r) => !r || typeof r !== "object")) throw new Error("invalid registry agents");
  return codexSessionCount(normalizeRegistryAgents(raw));
}

export async function withCodexSlot<T>(run: () => Promise<T>, opts: CodexSlotOptions = {}): Promise<T | SlotWait> {
  const inherited = owned.getStore();
  if (inherited) return inherited.held() ? run() : wait("Codex 全机槽锁已失租，等待重试");
  const lock = await acquireLock(opts.lockPath ?? statePath("scheduler-local-codex.lock"), 0);
  if (!lock) return wait("Codex 全机槽正在创建会话，等待重试");
  try {
    let n: number;
    try { n = count(opts.registryPath ?? REGISTRY_PATH); }
    catch (e) { return wait(`无法核实 Codex 全机会话数，等待：${(e as Error).message}`); }
    if (n >= LOCAL_CODEX_LIMIT) return wait(`Codex 全机会话已达 ${LOCAL_CODEX_LIMIT}，等待空槽`);
    if (!lock.held()) return wait("Codex 全机槽锁已失租，等待重试");
    return await owned.run(lock, run);
  } finally { lock.release(); }
}

/** Every manager create checks ownership again after any awaited worktree / ledger operation. */
export function codexSlotHeld(): boolean { return owned.getStore()?.held() === true; }
