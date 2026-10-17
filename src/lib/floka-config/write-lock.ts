/**
 * CFGWRITE1 · one write lock for config.json (recovery key configWriteSerialize, default on; roll back with
 * `ledger scheduler-recovery claude-orchestrator off --key configWriteSerialize --reason ...`).
 * - on: every writer (config-store setters, writeConfig, the rename config transaction) holds `<config>.lock` across its
 *   whole read → snapshot check → merge → atomic write. A missing file is a snapshot too, so a file created, deleted or
 *   edited after the read is a version change. The lock is re-entrant inside one async call chain, so a writer that already
 *   holds it never waits on itself. Timeout = ConfigWriteLockTimeoutError: nothing is written, never retried silently.
 * - observe: the old unlocked path; records once per target + disk version the write that on would have refused and replayed.
 * - off: the old path, nothing recorded.
 * The mode is re-read before every action, through the same strict reader as recovery-policy.ts (unreadable file = off), so
 * switching needs no restart. Samples carry the config's basename, the action and a short version hash: never values. They go
 * to an injected observe port (useConfigWritePort); the default one logs, since this module sits below the ledger.
 * tests/floka-config-write-race.test.ts.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { acquireLock } from "../file-lock.js";
import { barrierActive } from "../state-maintenance/barrier.js";
import { statePath } from "../paths.js";
import { readRecoveryFile, type RecoveryMode } from "../recovery-policy-file.js";
import type { ObservedAction } from "../recovery-policy.js";

const CONFIG_WRITE_KEY = "configWriteSerialize";
const PROJECT = "claude-orchestrator";

export class ConfigWriteLockTimeoutError extends Error {
  constructor(message = "配置写锁等待超时,本次没有写入,请重试") {
    super(message);
    this.name = "ConfigWriteLockTimeoutError";
  }
}

export interface ConfigWritePort {
  mode: () => RecoveryMode;
  /** observe sample; failing to record only loses a sample, never the write */
  observe: (a: ObservedAction) => void;
  waitMs: number;
  staleMs: number;
}

/** keys.configWriteSerialize → project mode → on (a new, non-high-risk key's default); unreadable / invalid file = off. */
export function configWriteModeAt(path: string): RecoveryMode {
  const r = readRecoveryFile(path);
  if (r.status === "corrupt") return "off";
  const cfg = r.status === "ok" && Object.hasOwn(r.data.projects, PROJECT) ? r.data.projects[PROJECT] : undefined;
  return cfg?.keys?.[CONFIG_WRITE_KEY] ?? cfg?.mode ?? "on";
}

const PRODUCTION: ConfigWritePort = {
  mode: () => configWriteModeAt(statePath("recovery-policy.json")),
  // No ledger import here (the config store sits below it); one deduplicated line per sample, key names and hashes only.
  observe: (a) => { console.error(`[floka-config] 恢复观察(${a.mechanism}):本会${a.action}(${a.target} ${a.actionKey})`); },
  waitMs: 10_000,
  staleMs: 30_000,
};
let port = PRODUCTION;
const seen = new Set<string>();
/** Wiring (a ledger-backed observe) and tests: swap the policy / sample / timing port (undefined = production). */
export function useConfigWritePort(p?: Partial<ConfigWritePort>): void { port = p ? { ...PRODUCTION, ...p } : PRODUCTION; seen.clear(); }

export const configWriteMode = (): RecoveryMode => port.mode();

const held = new AsyncLocalStorage<Set<string>>();

/**
 * The file a write to path actually replaces: writeJsonAtomic follows a symlinked file to its target, and a directory alias or a
 * relative spelling names the same file too. Lock ownership and re-entrancy key on this, so every spelling of one config shares
 * one lock. A missing file (or a dangling link, which the writer replaces in place) resolves through its nearest existing parent.
 */
export function configWriteTarget(path: string): string {
  const abs = resolve(path);
  try { return realpathSync(abs); } catch { /* missing / dangling: resolve the parent below */ }
  const rest: string[] = [];
  for (let dir = abs; ;) {
    rest.unshift(basename(dir));
    const up = dirname(dir);
    if (up === dir) return abs;
    try { return join(realpathSync(up), ...rest); } catch { dir = up; }
  }
}
export const configLockPath = (path: string): string => `${configWriteTarget(path)}.lock`;

/**
 * Run one whole read/modify/write under the config write lock (on), or as before (observe / off). Nested calls for the same
 * path inside the holder run directly instead of taking the lock again.
 */
export async function withConfigWriteLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const mine = held.getStore();
  const target = configWriteTarget(path);
  if (mine?.has(target)) return fn();
  if (port.mode() !== "on") return fn();
  // The lock sits beside the file, so its directory must exist first (the atomic writer used to create it). Never create it
  // during state-root maintenance: refuse the way the writer would instead of timing out on a lock that can't be made.
  const dir = dirname(target);
  if (!existsSync(dir)) {
    if (barrierActive()) throw new Error("state root maintenance in progress; refusing configuration write");
    mkdirSync(dir, { recursive: true });
  }
  const lock = await acquireLock(`${target}.lock`, port.waitMs, port.staleMs);
  if (!lock) throw new ConfigWriteLockTimeoutError();
  try {
    return await held.run(new Set([...(mine ?? []), target]), fn);
  } finally { lock.release(); }
}

/** Whether this call chain holds the lock for path, under any spelling (store.ts: snapshot rules apply only to serialized writes). */
export const holdsConfigWriteLock = (path: string): boolean => held.getStore()?.has(configWriteTarget(path)) ?? false;

const version = (v: unknown): string => createHash("sha256").update(JSON.stringify(v) ?? "missing").digest("hex").slice(0, 12);

/** observe: one sample per target + action + disk version (in process too, so a hot setter is not a ledger write per call). */
export async function observeConfigWrite(path: string, action: "missing-changed" | "deleted", disk: unknown): Promise<void> {
  const a: ObservedAction = { project: PROJECT, mechanism: CONFIG_WRITE_KEY, target: basename(path).replace(/[^\w.:@/-]/g, "_").slice(0, 120) || "config",
    actionKey: `${action}:${version(disk)}`, action: OBSERVED[action], data: { action } };
  const key = `${a.target}:${a.actionKey}`;
  if (seen.has(key)) return;
  if (seen.size >= 512) seen.clear();
  seen.add(key);
  try { port.observe(a); } catch (e) { console.error(`[floka-config] 记 ${a.mechanism} 观察失败(写入照旧):${(e as Error).message}`); }
}
const OBSERVED: Record<Parameters<typeof observeConfigWrite>[1], string> = {
  "missing-changed": "拒绝这次写入并重放:读时文件不存在,写前已被别处创建",
  deleted: "拒绝这次写入并重放:读后文件被删除",
};

