/**
 * 看板「这台机器」合计的取数入口：子进程跑 `manager cost --machine`（lib/machine-usage.ts 说明为什么不在 bridge 里扫）。
 */

import { formatTokens } from "../lib/agent-stats.js";
import { createMachineUsageCache } from "../lib/machine-usage-cache.js";
import type { MachineUsage } from "../lib/machine-usage.js";
import { runManagerProcess } from "../lib/run-manager.js";
import { formatResetTs } from "../lib/usage-cache.js";
import type { UsageWindowBounds } from "../lib/usage-window.js";
import { BUN_PATH, ENV_WITH_BUN, MANAGER_PATH } from "./config.js";

export type { MachineUsage };

export const machineUsage = createMachineUsageCache((args) =>
  runManagerProcess(args, { bunPath: BUN_PATH, managerPath: MANAGER_PATH, env: ENV_WITH_BUN, timeoutMs: 60_000 }),
);

/** 抓取时间 → "刚刚 / N 分钟前 / N 小时前"（用户要能看出 gauge 数据多旧） */
export function fmtAge(scrapedAt: number): string {
  const ms = Date.now() - scrapedAt;
  if (ms < 90_000) return "刚刚";
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)} 分钟前`;
  return `${(ms / 3_600_000).toFixed(1)} 小时前`;
}

/** 「本周」写明起点：周额度周期写「自 9/23 06:00」，拿不到重置时刻写「近 7 天」 */
function weekLabel(w: UsageWindowBounds | undefined): string {
  if (!w || w.weekSource !== "quota") return "近 7 天";
  return `本周（自 ${formatResetTs(w.weekStart / 1000)}）`;
}

/** Discord 看板 footer：全机合计 + 口径说明（agent 字段只是各自当前会话） */
export function machineFooter(m: MachineUsage | null | undefined, w: UsageWindowBounds | undefined): string {
  const src = "agent 行 = 各自当前会话 · 本地 JSONL + /status";
  if (!m) return `本机合计统计中… · ${src}`;
  const tok = (n: number) => formatTokens(n);
  return `本机合计（全部会话）今 ${tok(m.today.tokens)} · ${weekLabel(m.window ?? w)} ${tok(m.week.tokens)} · 扫描于 ${fmtAge(m.scannedAt)} · ${src}`;
}
