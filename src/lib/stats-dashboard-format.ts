/** Pure dashboard formatting; token formatting is injected to avoid loading session/state readers. */
import { boundaryLabel, type CtxBoundaryView } from "./ctx-boundary-decision.js";

export function fmtResets(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*$/, "").trim(); // 去掉尾部 (Asia/Singapore)
}

/**
 * 5h reset 时间是否可疑：reset 必落在抓取时刻的 5h 内，超出 = 上游 /status
 * 面板显示有误（Claude Code 2.1.204 实测过把 5pm 印成 5am）。只标记、不纠正 ——
 * 单一观测样本推不出错误形态，自动"翻转 am/pm"这类猜测可能把错值改成另一个
 * 错值还让用户无从发现；显示原文至少和用户自己跑 /status 看到的一致。
 * 周 reset 带日期无窗口约束，无从校验。
 */
export function sessionResetSuspect(s: string, scrapedAt: number): boolean {
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)\b/i);
  if (!m) return false;
  const d = new Date(scrapedAt);
  d.setHours(
    (parseInt(m[1], 10) % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0), // 12am→0、12pm→12
    m[2] ? parseInt(m[2], 10) : 0, 0, 0,
  );
  if (d.getTime() <= scrapedAt) d.setDate(d.getDate() + 1);
  return d.getTime() - scrapedAt > 5 * 3_600_000;
}

export function bar(pct: number | null, w = 10): string {
  if (pct == null) return "?".padEnd(w + 4);
  const f = Math.round((Math.min(100, pct) / 100) * w);
  return "▰".repeat(f) + "▱".repeat(w - f) + ` ${String(pct).padStart(3)}%`;
}

// 预警阈值（%）。上下文占用：≥75 该 compact 了；账号 limit：≥80 快撞墙。
const CTX_YELLOW = 50, CTX_RED = 75;
const LIMIT_YELLOW = 50, LIMIT_RED = 80;

export function ctxDot(pct: number): string {
  return pct >= CTX_RED ? "🔴" : pct >= CTX_YELLOW ? "🟡" : "🟢";
}
export const BOUNDARY_DOT: Record<CtxBoundaryView["level"], string> = { ok: "🟢", over: "🟡", cap: "🔴" };
/** 「🧭 执行类 余 35K」/「超 20K · 上限 250K」；配置有问题的策略带 ⚠ */
export function boundaryNote(v: CtxBoundaryView | null, formatTokens: (n: number) => string): string {
  if (!v || v.remaining === null) return v?.hardCap ? `\n🧭 ${boundaryLabel(v.policy)} · 上限 ${formatTokens(v.hardCap)}` : "";
  const left = v.remaining >= 0 ? `余 ${formatTokens(v.remaining)}` : `超 ${formatTokens(-v.remaining)}`;
  const cap = v.hardCap !== null ? ` · 上限 ${formatTokens(v.hardCap)}` : "";
  return `\n🧭 ${boundaryLabel(v.policy)} ${formatTokens(v.window)} ${left}${cap}${v.warnings.length ? " ⚠" : ""}`;
}
export function limitDot(pct: number | null): string {
  if (pct == null) return "⚪";
  return pct >= LIMIT_RED ? "🔴" : pct >= LIMIT_YELLOW ? "🟡" : "🟢";
}
/** embed 左侧边框色跟最严重的账号 limit 走：绿/黄/红 */
export function limitColor(pct: number | null): number {
  if (pct == null) return 0x5865f2;
  return pct >= LIMIT_RED ? 0xed4245 : pct >= LIMIT_YELLOW ? 0xfee75c : 0x57f287;
}

