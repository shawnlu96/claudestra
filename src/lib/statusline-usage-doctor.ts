/**
 * doctor 的「用量缓存」一行（只读）：statusline 用量缓存有 / 没有 / 陈旧 / 损坏，外加待批准的包装计划。
 * 没有缓存不是故障：后台照常跑，看板显示未知；要读数就配 statusline 或在网页用量看板手动刷新。
 */
import type { Check } from "./doctor.js";
import { usageCacheHealth } from "./account-usage-view.js";
import { pendingWrapPlan } from "./statusline-usage-install.js";

const G = "Claude Code 集成";
const DETAIL = {
  fresh: "有（statusline 正在写）",
  stale: "陈旧（statusline 超过 30 分钟没写：没有会话在跑，或 statusLine 没配我们的脚本）",
  missing: "没有（看板显示未知；不会为它去抓 TUI）",
  corrupt: "损坏（看板显示未知；下一次 statusline 渲染会覆盖）",
} as const;

export function checkUsageCache(nowMs = Date.now()): Check[] {
  const h = usageCacheHealth(nowMs);
  const plan = pendingWrapPlan(nowMs);
  const out: Check[] = [{
    group: G, name: "用量缓存", status: h === "fresh" ? "ok" : "warn", detail: DETAIL[h],
    ...(h === "fresh" ? {} : { fix: "bun run setup 会在 statusLine 未配时装上 scripts/statusline-usage.sh" }),
  }];
  if (plan) out.push({ group: G, name: "statusline 包装计划", status: "warn", detail: "你已有自己的 statusLine，包装计划等 owner 批准（未批准不改原配置）" });
  return out;
}
