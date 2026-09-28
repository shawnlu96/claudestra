/** per-agent restart 文件锁：从 manager.ts 逐字搬出（kill 也要看它——窗口暂时不在可能是 restart 在重建）。 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "fs";
import { statePath } from "../lib/paths.js";

/**
 * per-agent restart 跨进程互斥（v2.17.2，peer 2026-08-09 新证据：并发 restart
 * 期间启动命令被打进无关 agent 的窗口，把没参与竞态的 agent 打成空壳）。
 *
 * 关键：launcher 的 boot / periodic restore 是两个独立的 `bun run manager.ts
 * restart` **子进程**——进程内 Map 锁挡不住。cmdRestart 里 `gracefulExit →
 * kill → sleep(500) → new-window → send 启动命令` 全程无锁，两个子进程交错
 * 就能让 A 往 B 刚建的窗口发命令。P1 租约堵住了 launcher 侧的双跑，但 web /
 * 手动 restart 与 launcher 仍可能并发——文件锁是不依赖上游守规矩的纵深防御。
 */
const RESTART_LOCK_DIR = statePath("locks");
const RESTART_LOCK_STALE_MS = 3 * 60_000;

export function tryLockRestart(tmuxName: string, depth = 0): boolean {
  const lock = `${RESTART_LOCK_DIR}/restart-${tmuxName}.lock`;
  try {
    mkdirSync(RESTART_LOCK_DIR, { recursive: true });
    const fd = openSync(lock, "wx"); // O_EXCL：已存在即抛
    writeSync(fd, `${process.pid}\n${Date.now()}`);
    closeSync(fd);
    return true;
  } catch {
    if (depth > 0) return false; // 只接管一次，避免抢锁循环
    try {
      const [pidS, tsS] = readFileSync(lock, "utf8").split("\n");
      const pid = parseInt(pidS, 10);
      const ts = parseInt(tsS, 10) || 0;
      let alive = false;
      if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch { /* 死了 */ } }
      if (!alive || Date.now() - ts > RESTART_LOCK_STALE_MS) {
        unlinkSync(lock); // 陈旧（持有进程已死 / 超时）→ 接管
        return tryLockRestart(tmuxName, depth + 1);
      }
    } catch { /* 读锁失败按被占处理 */ }
    return false;
  }
}

/** 该 agent 是否正有 restart 在跑（cmdList 的 dead 判定要避开这段窗口期）。
 *  锁陈旧（进程已死 / 超 3min）按「没在跑」处理，与 tryLockRestart 的接管判据一致。 */
export function isRestartInProgress(tmuxName: string): boolean {
  try {
    const raw = readFileSync(`${RESTART_LOCK_DIR}/restart-${tmuxName}.lock`, "utf8");
    const [pidStr, tsStr] = raw.split("\n");
    const pid = Number(pidStr);
    const ts = Number(tsStr);
    if (Number.isFinite(ts) && Date.now() - ts > 3 * 60_000) return false;
    if (Number.isFinite(pid)) {
      try { process.kill(pid, 0); } catch { return false; } // 进程没了 = 孤儿锁
    }
    return true;
  } catch {
    return false; // 没锁
  }
}

export function unlockRestart(tmuxName: string): void {
  try { unlinkSync(`${RESTART_LOCK_DIR}/restart-${tmuxName}.lock`); } catch { /* 已删 */ }
}
