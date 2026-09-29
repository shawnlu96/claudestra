/**
 * 本机私钥文件「读，没有就生成」（0600）：先写临时文件再 link，link 是原子的，别的进程读到的要么没有、要么是完整的；
 * 两个进程同时首用时只有一个 link 成功，另一个读回它的——一台机器只能有一把。
 * 用在 lib/instance-key.ts（Ed25519 身份钥）与 lib/e2e-machine-key.ts（P-256 E2E 钥）。
 */
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readOrCreateKeyFile(path: string, generate: () => string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
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
