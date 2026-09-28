/**
 * 「这台机器」的 token 用量：窗口内有写入的**全部**会话文件（Claude Code 含子 agent / workflow 子 agent、
 * Pi、Codex），不只是在册 agent 的当前会话——已 kill 的执行者、/clear 换掉的旧会话、cron 临时 agent、
 * owner 自己终端开的会话都算。按响应去重（usageDedupKey，跨文件共用一份集合：fork / resume 会抄历史行）。
 *
 * 只在子进程里跑（`manager cost --machine`，bridge 侧见 bridge/machine-usage.ts）：全机一次要解析几百 MB，
 * 临时字符串峰值 200MB 级，放进 bridge 就是 513MB 会话那次的同类 RSS 棘轮；子进程退出即全部归还。
 */

import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "fs";
import { join } from "path";
import { readFileStats, scanStatsWindow, type UsageWindow } from "./agent-stats.js";
import { codexSessionsRoot } from "./codex-session.js";
import { piAgentDir } from "./pi-session.js";
import { claudeProjectsRoot } from "./runtimes/claude-code.js";
import { runtimeForSessionPath } from "./session-source.js";
import { windowFloor, type UsageWindowBounds } from "./usage-window.js";

interface UsagePair {
  today: UsageWindow;
  week: UsageWindow;
}

export interface MachineUsage extends UsagePair {
  /** 键 = runtime（claude-code / codex / pi） */
  byRuntime: Record<string, UsagePair>;
  window: UsageWindowBounds;
  files: number;
  bytesRead: number;
  scanMs: number;
  scannedAt: number;
}

const emptyWin = (): UsageWindow => ({ tokens: 0, requests: 0, costUsd: 0, reportedCostUsd: 0 });
const emptyPair = (): UsagePair => ({ today: emptyWin(), week: emptyWin() });

function addWin(acc: UsageWindow, w: UsageWindow): void {
  acc.tokens += w.tokens;
  acc.requests += w.requests;
  acc.costUsd += w.costUsd;
  acc.reportedCostUsd += w.reportedCostUsd;
}

/** 各运行时会话根目录（Pi 的根可被 PI_CODING_AGENT_DIR 覆盖，与 Pi 自身一致） */
function usageRoots(): string[] {
  return [claudeProjectsRoot(), join(piAgentDir(), "sessions"), codexSessionsRoot()];
}

/**
 * 根目录下 mtime ≥ sinceMs 的 .jsonl（按 dirent 递归，不数层数：workflow 子 agent 的文件在第 11 层）。
 * mtime 早于窗口 = 窗口内没写过 = 不可能有窗口内的记录，整个文件跳过。
 */
export function listRecentJsonl(roots: string[], sinceMs: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 16) return; // 防软链环
    let ents: import("fs").Dirent[];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; } // 根不存在（没装这个运行时）/ 扫描中被删
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith(".jsonl")) {
        try { if (statSync(p).mtimeMs >= sinceMs) out.push(p); } catch { /* 刚被挪走：这一刻它不在窗口内 */ }
      }
    }
  };
  for (const r of roots) walk(r, 0);
  return out;
}

const CHUNK_BYTES = 2 * 1024 * 1024;

/**
 * 从文件尾按块往前读，逐块交给 scanStatsWindow（共享去重集合）；某块里出现早于窗口下界的记录就停。
 * 块边界落在行中间：该块第一个 \n 之前的字节并进上一块（按字节拼，不在 UTF-8 多字节中间切字符串）。
 */
function scanFileBackwards(
  path: string, runtime: string | undefined, w: UsageWindowBounds, seen: Set<string>, acc: UsagePair, chunkBytes: number,
): number {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return 0; } // 扫描期间被删：不计
  let bytes = 0;
  try {
    let pos = fstatSync(fd).size; // 与读的是同一个打开的文件（open 与 stat 之间被轮转 / 替换也对得上）
    let carry = Buffer.alloc(0);
    const floor = windowFloor(w.dayStart, w.weekStart);
    while (pos > 0) {
      const n = Math.min(chunkBytes, pos);
      pos -= n;
      const buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, pos);
      bytes += n;
      const joined = carry.length ? Buffer.concat([buf, carry]) : buf;
      let start = 0;
      if (pos > 0) {
        const nl = joined.indexOf(10);
        if (nl < 0) { carry = joined; continue; } // 一整块都是同一行的中段
        carry = joined.subarray(0, nl);
        start = nl + 1;
      } else carry = Buffer.alloc(0);
      const lines = joined.toString("utf8", start).split("\n");
      const { stats, oldestTs } = scanStatsWindow(lines, w.dayStart, w.weekStart, runtime, seen);
      addWin(acc.today, stats.today);
      addWin(acc.week, stats.week);
      if (oldestTs < floor) break;
    }
  } finally {
    closeSync(fd);
  }
  return bytes;
}

/** 全机扫描。Codex 走它自己的累计计数扫描器（按文件做差，不参与按响应去重） */
export async function scanMachineUsage(
  w: UsageWindowBounds,
  roots = usageRoots(),
  /** 单测调小，在小 fixture 上走跨块拼行的路径 */
  chunkBytes = CHUNK_BYTES,
): Promise<MachineUsage> {
  const t0 = performance.now();
  const files = listRecentJsonl(roots, windowFloor(w.dayStart, w.weekStart));
  const seen = new Set<string>();
  const total = emptyPair();
  const byRuntime: Record<string, UsagePair> = {};
  let bytesRead = 0;
  for (const f of files) {
    const runtime = runtimeForSessionPath(f);
    const part = emptyPair();
    if (runtime === "codex") {
      const s = await readFileStats(f, { window: w });
      part.today = s.today;
      part.week = s.week;
    } else {
      bytesRead += scanFileBackwards(f, runtime, w, seen, part, chunkBytes);
    }
    const key = runtime ?? "claude-code";
    const r = (byRuntime[key] ??= emptyPair());
    for (const k of ["today", "week"] as const) {
      addWin(r[k], part[k]);
      addWin(total[k], part[k]);
    }
  }
  return {
    ...total, byRuntime, window: w, files: files.length, bytesRead,
    scanMs: Math.round(performance.now() - t0), scannedAt: Date.now(),
  };
}
