/**
 * 本机私钥文件「读，没有就生成」（0600）：先写临时文件再 link，link 是原子的，别的进程读到的要么没有、要么是完整的；
 * 两个进程同时首用时只有一个 link 成功，另一个读回它的——一台机器只能有一把。
 * 用在 lib/instance-key.ts（Ed25519 身份钥）与 lib/e2e-machine-key.ts（P-256 E2E 钥）。
 */
import { createPrivateKey } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { barrierActive, enterIdentityGeneration, MaintenanceBarrierError } from "./state-maintenance/barrier.js";
import { maintenanceRoot } from "./state-maintenance/paths.js";

/**
 * 状态根维护中缺失、或现有内容解析不出私钥,则抛 MaintenanceBarrierError(lib/state-maintenance/barrier.ts):零 mkdir、零临时文件。
 * 无效也在这里拒:调用方(如 e2e-machine-key)把普通解析错误吞成 null,维护中不能让它悄悄变成「没有钥匙照常继续」。
 */
export function readOrCreateKeyFile(path: string, generate: () => string, maintRoot: string = maintenanceRoot()): string {
  const existing = readIfPresent(path);
  if (existing !== null) return invalidPem(existing) && barrierActive(maintRoot) ? refuseInvalid(path) : existing;
  const release = enterIdentityGeneration(basename(path), maintRoot);
  try {
    return readIfPresent(path) ?? createUnderMutex(path, generate);
  } finally {
    release();
  }
}

function invalidPem(pem: string): boolean {
  try {
    createPrivateKey(pem);
    return false;
  } catch {
    return true; // 解析失败就算无效;错误里可能带内容片段,不外抛
  }
}

function refuseInvalid(path: string): never {
  throw new MaintenanceBarrierError(`状态根维护中,${basename(path)}无效,拒绝替换或生成`);
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
