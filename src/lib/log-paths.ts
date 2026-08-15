/**
 * v2.19.0 守护进程日志落点 —— 从 `/tmp` 搬到 `~/.claude-orchestrator/logs/`。
 *
 * 为什么搬（2026-08-15 排查事故时踩到）：macOS 会定期清理 `/tmp`，实测
 * `/tmp/claudestra-bridge.err` 被**删掉了**，而 bridge 进程还开着那个 fd ——
 * 于是 stderr 一直写进一个已经 unlink 的 inode，从文件系统上完全看不见。
 * 排查一个「消息发出去了但日志里没有」的疑案时，看不到 stderr 直接让证据链
 * 断了一大截，白白拖长了整个定位过程。
 *
 * 日志是排障的第一现场，不能放在一个系统会背着你删的目录里。
 *
 * 轮转用 **copytruncate**：launchd 在 spawn 之前就按路径打开了 stdout/stderr，
 * 重命名的话它会继续往改名后的文件写（又是 unlinked-inode 那个坑）。所以先
 * 复制一份到 `.1`，再把原文件 **truncate 到 0** —— inode 不变，launchd 的 fd
 * 依然有效，O_APPEND 从头开始写。
 */

import { existsSync, statSync, copyFileSync, truncateSync, mkdirSync } from "fs";
import { join } from "path";

export const LOG_DIR = join(process.env.HOME || "~", ".claude-orchestrator", "logs");

/** 单个日志上限：超过就轮转（保留一代） */
export const LOG_ROTATE_BYTES = 32 * 1024 * 1024;

export type LogKind = "out" | "err";

/** 新落点：~/.claude-orchestrator/logs/<stem>.<kind> */
export function logPath(stem: string, kind: LogKind): string {
  return join(LOG_DIR, `${stem}.${kind}`);
}

/** 旧落点（/tmp）。诊断/提示信息里做兼容回退用——老安装重装 CLI 之前还写在那儿。 */
export function legacyLogPath(stem: string, kind: LogKind): string {
  return `/tmp/claudestra-${stem}.${kind}`;
}

/** 优先返回存在的那个（新 → 旧），两个都不在就返回新路径 */
export function resolveLogPath(stem: string, kind: LogKind): string {
  const p = logPath(stem, kind);
  if (existsSync(p)) return p;
  const legacy = legacyLogPath(stem, kind);
  return existsSync(legacy) ? legacy : p;
}

export function ensureLogDir(): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    /* 建不出来就退回 launchd 原样行为 */
  }
}

/** copytruncate 轮转一个文件；返回是否真的转了 */
export function rotateIfLarge(path: string, maxBytes = LOG_ROTATE_BYTES): boolean {
  try {
    if (!existsSync(path)) return false;
    if (statSync(path).size < maxBytes) return false;
    copyFileSync(path, `${path}.1`);
    truncateSync(path, 0);
    return true;
  } catch {
    return false; // 轮转失败不能影响启动
  }
}

/**
 * daemon 启动时调一次：保证目录在、并把自己的 out/err 轮转掉。
 * 只在启动时做——进程运行期间 rename/truncate 都可能和 launchd 的 fd 打架。
 */
export function initDaemonLogs(stem: string): void {
  ensureLogDir();
  for (const kind of ["out", "err"] as LogKind[]) rotateIfLarge(logPath(stem, kind));
}
