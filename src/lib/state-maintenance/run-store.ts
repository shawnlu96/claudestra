/**
 * 一次维护运行的根外控制文件(control/runs/<runId>/):请求、状态、恢复清单、迁移前清单、取消标记、维护页访问码。
 * 每次改状态都先落盘再进入下一步;请求以原子改名「领取」,同一请求不会被两个执行器各跑一次。
 * 执行器独占锁 control/executor.lock 常开不关:它同时是停写探针的 canary(lsof 必须看得到)。
 */

import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { IdentityInventory, TreeInventory } from "./inventory.js";
import { ensureDir, FILE_MODE, maintPaths, runDir } from "./paths.js";
import type { ServiceState, SessionSnapshot } from "./services.js";

export interface RunRequest {
  runId: string;
  actor: string;
  reportRunId: string;
  reportRel: string;
  reportSha256: string;
  baseline: string;
  /** 旧根 + 新根的摘要:执行器按同一规则重算,对不上即拒绝(请求里不放绝对路径) */
  rootsDigest: string;
  createdAt: number;
  /** 执行器必须在此之前领取 */
  expiresAt: number;
}

export type Phase =
  | "starting" | "ready" | "stopping" | "probing" | "pre-inventory" | "migrating" | "verifying" | "rolling-back"
  | "recording" | "restoring" | "done" | "restore-failed" | "refused" | "failed-holding" | "cancelled";

export interface Comparison { stage: string; executed: boolean; layout?: string; identityDiff?: string[]; treeDiff?: string[]; note?: string }

export interface RunState {
  runId: string;
  phase: Phase;
  /** 结论:migrated(迁移并校验通过)/ rolled-back / refused / failed / cancelled;进行中为 null */
  outcome: "migrated" | "rolled-back" | "refused" | "failed" | "cancelled" | null;
  error?: string;
  stopped: string[];
  comparisons: Comparison[];
  restore?: { ok: boolean; problems: string[] };
  note?: { ok: boolean; error?: string };
  rollbackAttempt: number;
  history: { phase: Phase; at: number; note?: string }[];
}

export interface Manifest { services: ServiceState[]; sessions: SessionSnapshot; recordedAt: number }

export interface PreInventory { identity: IdentityInventory; tree: TreeInventory; layout: string }

export const runPaths = (root: string, runId: string) => {
  const dir = runDir(join(maintPaths(root).control, "runs"), runId);
  return {
    dir,
    request: join(dir, "request.json"),
    taken: join(dir, "request.taken.json"),
    state: join(dir, "state.json"),
    manifest: join(dir, "manifest.json"),
    pre: join(dir, "pre-inventory.json"),
    cancel: join(dir, "cancel"),
    access: join(dir, "access.json"),
    servePid: join(dir, "serve.pid"),
  };
};

export function writeJson0600(path: string, v: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v), { mode: FILE_MODE });
  renameSync(tmp, path);
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`控制文件损坏:${(e as Error).message}`);
  }
}

export function createRequest(root: string, req: RunRequest): void {
  const p = runPaths(root, req.runId);
  ensureDir(join(maintPaths(root).control, "runs"));
  ensureDir(p.dir);
  writeJson0600(p.request, req);
}

/** 原子领取请求;已领取 / 不存在返回 null */
export function takeRequest(root: string, runId: string): RunRequest | null {
  const p = runPaths(root, runId);
  try {
    renameSync(p.request, p.taken);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  return readJson<RunRequest>(p.taken);
}

export const takenRequest = (root: string, runId: string): RunRequest | null => readJson<RunRequest>(runPaths(root, runId).taken);

export function loadState(root: string, runId: string): RunState | null {
  return readJson<RunState>(runPaths(root, runId).state);
}

export function saveState(root: string, s: RunState, phase?: Phase, note?: string): RunState {
  if (phase) {
    s.phase = phase;
    s.history.push({ phase, at: Date.now(), ...(note ? { note } : {}) });
  }
  writeJson0600(runPaths(root, s.runId).state, s);
  return s;
}

export const newState = (runId: string): RunState =>
  ({ runId, phase: "starting", outcome: null, stopped: [], comparisons: [], rollbackAttempt: 0, history: [{ phase: "starting", at: Date.now() }] });

/** 报告只绑定一次:第二次用同一份报告发起执行直接拒绝 */
export function bindReport(root: string, reportRunId: string, runId: string): boolean {
  const dir = join(maintPaths(root).control, "report-bound");
  ensureDir(dir);
  try {
    writeFileSync(join(dir, `${reportRunId}.json`), JSON.stringify({ runId }), { mode: FILE_MODE, flag: "wx" });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

export interface ExecutorLock { fd: number; path: string; release(): void }

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** 执行器独占锁;持有者已死才回收。返回的 fd 一直开着,直到 release */
export function takeExecutorLock(root: string): ExecutorLock | { error: string } {
  const path = join(maintPaths(root).control, "executor.lock");
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, "wx", FILE_MODE);
      writeSync(fd, String(process.pid));
      return { fd, path, release: () => { closeSync(fd); if (existsSync(path)) unlinkSync(path); } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return { error: `取执行器锁失败:${(e as Error).message}` };
      const holder = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) return { error: `另一个维护执行器(pid ${holder})正在运行` };
      unlinkSync(path);
    }
  }
  return { error: "取执行器锁失败(反复被抢)" };
}
