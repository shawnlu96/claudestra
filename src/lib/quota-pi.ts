/**
 * Pi 各接入商的本周用量 → 订阅额度看板的 ProviderEntry（纯函数；设计稿 T2b §1、quota-layers 的 extra）。
 * 数据来自全机扫描子进程（lib/machine-usage.ts 的 piProviders，按 Pi 会话行的 provider 字段拆）。
 * 按量接入商没有「额度」：只给本周 tokens 与花费（运行时自报的 + 按牌价估的），数据层固定是本机记录。
 * 单测 tests/quota-pi.test.ts。
 */

import type { MachineUsage } from "./machine-usage.js";
import type { ProviderEntry } from "./quota-layers.js";

export function piProviderEntries(m: Pick<MachineUsage, "piProviders" | "window" | "scannedAt"> | null): ProviderEntry[] {
  if (!m?.piProviders) return [];
  // 本周周期从 weekStart 起到扫描时刻；前端据 periodMinutes 写「本周」的口径
  const minutes = Math.max(1, Math.round((m.scannedAt - m.window.weekStart) / 60_000));
  return Object.entries(m.piProviders)
    .filter(([, u]) => u.week.tokens > 0 || u.week.requests > 0)
    .sort(([, a], [, b]) => b.week.tokens - a.week.tokens)
    .map(([name, u]) => ({
      id: `pi:${name}`,
      name,
      kind: "api",
      account: { key: null, identity: "unknown" },
      meters: [
        { id: "week_tokens", kind: "usage", label: null, unit: "tokens", used: u.week.tokens, periodMinutes: minutes },
        { id: "week_usd", kind: "usage", label: null, unit: "usd", used: u.week.costUsd + u.week.reportedCostUsd, periodMinutes: minutes },
      ],
      source: { layer: "local_cache", observedAt: m.scannedAt, reason: null },
    }));
}
