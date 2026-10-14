/**
 * 本机私钥文件「读，没有就生成」（0600）：先写临时文件再 link，link 是原子的，别的进程读到的要么没有、要么是完整的；
 * 两个进程同时首用时只有一个 link 成功，另一个读回它的——一台机器只能有一把。
 * 用在 lib/instance-key.ts（Ed25519 身份钥）与 lib/e2e-machine-key.ts（P-256 E2E 钥）。
 */
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { enterIdentityGeneration } from "./state-maintenance/barrier.js";
import { maintenanceRoot } from "./state-maintenance/paths.js";

/** 状态根维护中缺失则抛 MaintenanceBarrierError(lib/state-maintenance/barrier.ts):零 mkdir、零临时文件 */
export function readOrCreateKeyFile(path: string, generate: () => string, maintRoot: string = maintenanceRoot()): string {
  const existing = readIfPresent(path);
  if (existing !== null) return existing;
  const release = enterIdentityGeneration(basename(path), maintRoot);
  try {
    return readIfPresent(path) ?? createUnderMutex(path, generate);
  } finally {
    release();
  }
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return null;
  }
}

function createUnderMutex(path: string, generate: () => string): string {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, generate(), { mode: 0o600 });
  try {
    linkSync(tmp, path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
  return readFileSync(path, "utf8");
}
