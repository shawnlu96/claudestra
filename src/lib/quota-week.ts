/**
 * 「本周已用」（i28-Q1 网页分配表）：每家只取周窗口（kind weekly，"7d"）的已用百分比和重置时刻，别的一律不出这里——
 * 这份既给本机面板看，也随 hello 发给借入方（lend-hello.ts），所以里面不能有账户、token、会话 id（验收线 3）。
 * 来源就是 AI 清单的额度段（ai-quota.ts readInventoryQuota：订阅快照 + statusline 缓存 + Codex rollout rate_limits），不另找。
 * 读不到 / 已过重置时刻 = 这家不出现；只做参考，派单不看它。rollout 扫描不便宜，结果缓存 60 秒。
 * 借入方收到的各 peer 上报只记在 bridge 内存（notePeerQuota）：不落库，重启后等下一次 hello 补上，期间显示「—」。tests/quota-week.test.ts。
 */
import { readInventoryQuota, type InventoryQuota } from "./ai-quota.js";
import { isWallState, QUOTA_WALL_PATH, wallActive, type WallState } from "./quota-wall.js";
import { readJsonStateSync } from "./state-file.js";

export interface WeekQuota { weekUsedPct: number; resetAt: number }
export type QuotaReport = Partial<Record<"codex" | "claude", WeekQuota>>;
export const QUOTA_FAMILIES = ["codex", "claude"] as const;

/** 周窗口的整数百分比（0..100 夹住）与重置时刻；没有周窗口、百分比未知、重置时刻没有或已过 → null */
export function weekOf(q: InventoryQuota, now: number): WeekQuota | null {
  const w = q.windows.find((x) => x.kind === "weekly");
  if (!w || w.usedPct === null || !Number.isFinite(w.usedPct) || w.resetsAtMs === null || w.resetsAtMs <= now) return null;
  return { weekUsedPct: Math.min(100, Math.max(0, Math.round(w.usedPct))), resetAt: Math.round(w.resetsAtMs) };
}

export function reportOf(all: Record<"codex" | "claude", InventoryQuota>, now: number): QuotaReport {
  const out: QuotaReport = {};
  for (const f of QUOTA_FAMILIES) {
    const w = weekOf(all[f], now);
    if (w) out[f] = w;
  }
  return out;
}

const CACHE_MS = 60_000;
let cache: { at: number; value: QuotaReport } | null = null;

/** 本机这一份；任何一步抛错都按「都不知道」（空对象）给，原因进日志——额度只是参考，不能拖垮面板或 hello */
export async function readWeekQuota(now = Date.now(), read: () => Promise<Record<"codex" | "claude", InventoryQuota>> = readInventoryQuota): Promise<QuotaReport> {
  if (cache && now - cache.at >= 0 && now - cache.at < CACHE_MS) return dropPassed(cache.value, now);
  try {
    const value = reportOf(await read(), now);
    cache = { at: now, value };
    return value;
  } catch (e) {
    console.warn(`⚠️ [quota-week] 读额度失败，按未知显示：${(e as Error).message}`);
    return {};
  }
}

/** 缓存里的值过了重置时刻就不再给（新窗口用了多少没人知道） */
function dropPassed(r: QuotaReport, now: number): QuotaReport {
  const out: QuotaReport = {};
  for (const f of QUOTA_FAMILIES) if (r[f] && r[f]!.resetAt > now) out[f] = r[f];
  return out;
}

/** 本机 Claude Code 此刻是否撞着额度墙（quota-wall.json）：只是一个标，不是用量；读不到 = false */
export function localWalled(path = QUOTA_WALL_PATH): boolean {
  try {
    const r = readJsonStateSync(path, isWallState);
    return r.status === "ok" && wallActive(r.data as WallState);
  } catch (e) {
    console.warn(`⚠️ [quota-week] 读额度墙失败，按没撞墙显示：${(e as Error).message}`);
    return false;
  }
}

/** 一小时没再收到 = 不再显示（对方 hello 通常几分钟一次，停了这么久的旧数不当参考） */
const PEER_KEEP_MS = 3_600_000;
const peers = new Map<string, { quota: QuotaReport; at: number }>();

/** hello 被台账接受后调；quota 不带（旧版出借方）= 删掉这台的旧数 */
export function notePeerQuota(peer: string, quota: QuotaReport | undefined, now = Date.now()): void {
  if (quota === undefined) peers.delete(peer);
  else peers.set(peer, { quota, at: now });
}

/** 这台 peer 最近上报的本周额度；没有 / 太旧 = null，单家已过重置时刻的那家不给 */
export function peerQuota(peer: string, now = Date.now()): QuotaReport | null {
  const e = peers.get(peer);
  if (!e || now - e.at > PEER_KEEP_MS) return null;
  return dropPassed(e.quota, now);
}

/** 单测：清缓存和 peer 表 */
export const resetWeekQuotaCacheForTest = (): void => {
  cache = null;
  peers.clear();
};
