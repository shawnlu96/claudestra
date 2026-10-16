/**
 * QWD-1：Claude 的周重置时刻每次观测都带几百毫秒抖动（生产 lend-quota-line-facts.json 连续三次 live 观测：
 * 1792418399564 / 1792418399963 / 1792418400347）。QUOTA1 起顶部额度卡按「族 + 严重度 + 重置时刻」记关掉，重置时刻比较
 * 用 RESET_JITTER_MS 容差：同一周的抖动不算新窗口，关掉后不再弹；真到了新的一周再弹。走卡片同一顺序：关掉 → 经 localStorage 往返 → 每次轮询判断。
 */
import { describe, expect, test } from "bun:test";
import type { FamilyLine, QuotaLinesView } from "../web/features/lend/lend-quota-model";
import { RESET_JITTER_MS, sameGen } from "../web/features/lend/quota-warning-model";
import { dismissRows, isRowDismissed, noticeRows, parseNoticeDismiss, type NoticeDismiss } from "../web/features/quota/quota-notice-model";

const NOW = 1792058526130;
const SEEN = [1792418399564, 1792418399963, 1792418400347];
const f = (over: Partial<FamilyLine> = {}): FamilyLine => ({ family: "claude", warnPct: 90, stopPct: 99, weekUsedPct: 95, resetAt: SEEN[0]!, observedAt: NOW,
  source: "live", freshness: "fresh", state: "warn", mode: "on", limit: "half", wouldLimit: "half", granted: 2, lineCap: 2, available: 1, slots: 1, ...over });
const view = (fl: FamilyLine): QuotaLinesView => ({ ok: true, config: { status: "ok", error: null, mode: "on" }, at: NOW, families: [fl] });

const shown = (m: NoticeDismiss, fl: FamilyLine) => noticeRows(view(fl), null, NOW).some((r) => !isRowDismissed(m, "fp1", r));
const closed = parseNoticeDismiss(JSON.stringify(dismissRows({}, "fp1", noticeRows(view(f()), null, NOW))));

describe("同一周 resetAt 抖动不算新窗口", () => {
  test("生产实测的三次读数轮流出现：关掉后都不再弹", () => {
    for (const resetAt of [...SEEN, SEEN[0]!, SEEN[2]!]) expect(shown(closed, f({ resetAt }))).toBe(false);
  });
  test("差几百毫秒、几秒、几分钟内：不再弹（跨分钟边界也一样）", () => {
    for (const d of [1, 400, 5_000, 60_000, RESET_JITTER_MS]) expect(shown(closed, f({ resetAt: SEEN[0]! + d }))).toBe(false);
  });
});

describe("真换窗口 / 升级仍再弹", () => {
  test("新的一周（resetAt 差一天以上）", () => expect(shown(closed, f({ resetAt: SEEN[0]! + 7 * 86_400_000 }))).toBe(true));
  test("提醒 → 不再接新活", () => expect(shown(closed, f({ resetAt: SEEN[1]!, state: "stop", limit: "zero" }))).toBe(true));
});

describe("sameGen（旧记录迁移仍用）", () => {
  test("线 / 模式必须全等，resetAt 只在两边都是数字时容差", () => {
    expect(sameGen(`${SEEN[0]}|90/99|on`, `${SEEN[2]}|90/99|on`)).toBe(true);
    expect(sameGen(`${SEEN[0]}|90/99|on`, `${SEEN[0]}|80/99|on`)).toBe(false);
    expect(sameGen("noreset|90/99|on", `${SEEN[0]}|90/99|on`)).toBe(false);
  });
});
