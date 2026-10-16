/**
 * web/features/quota/quota-notice-model.ts（QUOTA1）：两个读数（/quota/wall、/lend/quota-lines）→ 顶部额度卡每族最多一行（用完 > 不再接新活 > 到提醒线），
 * 额度摘要（今天页额度行、用量看板顶部）；关掉按「实例 + 族 + 严重度 + 重置时刻」，升级 / 新窗口再出；旧的两个关闭键读一次迁过来。
 * 对照基准四组合成状态：1 Claude 82% 到提醒线、Codex 18%；2 Claude 周额度用完（排队 3、可重置 2）+ Codex 95% 不再接新活；3 恢复中；4 都正常。
 * 「额度闸横幅」显示模型的情形由 tests/web-notice-merge.test.ts 挪来（见文末 describe）。
 */
import { describe, expect, test } from "bun:test";
import type { FamilyLine, QuotaLinesView } from "../web/features/lend/lend-quota-model";
import { DISMISS_KEY as OLD_WARNING_KEY } from "../web/features/lend/quota-warning-model";
import {
  dismissRows, isRowDismissed, loadNoticeDismiss, mergeNoticeDismiss, noticeRows, NOTICE_DISMISS_KEY, OLD_WALL_KEY, parseNoticeDismiss, summaryParts,
  type NoticeRow,
} from "../web/features/quota/quota-notice-model";
import type { WallResponse } from "../web/features/quota-wall/wall-banner-model";
import { BANNED_OWNER_WORDS } from "../web/lib/owner-words";

const NOW = new Date(2026, 9, 14, 12, 0).getTime(); // 本地时区 10/14 12:00
const RESET = new Date(2026, 9, 17, 9, 0).getTime(); // 周重置 10/17 09:00
const WALL_RESET = new Date(2026, 9, 14, 15, 0).getTime(); // 闸 10/14 15:00 重置（3 小时后）
const line = (family: "claude" | "codex", pct: number, state: FamilyLine["state"], over: Partial<FamilyLine> = {}): FamilyLine => ({
  family, warnPct: 80, stopPct: 90, weekUsedPct: pct, resetAt: RESET, observedAt: NOW - 60_000, source: "live", freshness: "fresh", state, mode: "on",
  limit: state === "stop" ? "zero" : state === "warn" ? "half" : "none", wouldLimit: "none", granted: 2, lineCap: 2, available: 2, slots: 2, ...over });
const view = (families: FamilyLine[], mode: "on" | "observe" | "off" = "on"): QuotaLinesView => ({ ok: true, config: { status: "ok", error: null, mode }, at: NOW, families });
const NO_WALL: WallResponse = { active: false, queued: 0, wall: null };
const wallOut = (over: Partial<NonNullable<WallResponse["wall"]>> = {}, top: Partial<WallResponse> = {}): WallResponse =>
  ({ active: true, queued: 3, credits: 2, wall: { kind: "weekly", resetsAt: WALL_RESET, enteredAt: NOW - 600_000, agents: ["agent-a"], ...over }, ...top });

/** 四组合成状态（对照基准） */
const S1 = { lines: view([line("claude", 82, "warn"), line("codex", 18, "below")]), wall: NO_WALL };
const S2 = { lines: view([line("claude", 100, "stop"), line("codex", 95, "stop")]), wall: wallOut() };
const S3 = { lines: view([line("claude", 40, "below"), line("codex", 18, "below")]), wall: { active: false, wall: { kind: "weekly", enteredAt: NOW - 600_000, recovering: true } } };
const S4 = { lines: view([line("claude", 62, "below"), line("codex", 18, "below")]), wall: NO_WALL };
const rows = (s: { lines: QuotaLinesView; wall: WallResponse }) => noticeRows(s.lines, s.wall, NOW);
const fill = (p: { text: string; vars: Record<string, string | number> }) => p.text.replace(/\{(\w+)\}/g, (_, k: string) => String(p.vars[k]));

describe("四组状态 → 卡片的行", () => {
  test("1：只出 Claude 一行「到提醒线」", () => {
    const r = rows(S1);
    expect(r.map((x) => [x.family, x.level])).toEqual([["claude", "warn"]]);
    expect(fill(r[0]!.title)).toBe("Claude 本周已用 82%，到提醒线了");
    expect(r[0]!.detail.map(fill)).toEqual(["仍在接新活，能同时跑的数量已减半", "10/17 09:00 重置"]);
    expect(r[0]!.canClear).toBe(false);
  });
  test("2：两行同一张卡——Claude「用完 · 时间重置」带排队与重置次数、可「已恢复」；Codex「不再接新活」", () => {
    const r = rows(S2);
    expect(r.map((x) => [x.family, x.level])).toEqual([["claude", "out"], ["codex", "stop"]]);
    expect(fill(r[0]!.title)).toBe("Claude 本周额度用完，10/14 15:00 重置");
    expect(r[0]!.detail.map(fill)).toEqual(["约 3 小时后", "排队 3 条 agent 消息，恢复后自动送达", "有 2 次重置可用，在会话里发 /limit-reset"]);
    expect(r[0]!.canClear).toBe(true);
    expect(fill(r[1]!.title)).toBe("Codex 本周已用 95%，不再接新活");
    expect(r[1]!.detail.map(fill)).toEqual(["已不再接新活，在跑的活照常做完", "10/17 09:00 重置"]);
  });
  test("3：恢复中一行，没有「已恢复」按钮", () => {
    const r = rows(S3);
    expect(r.map((x) => [x.family, x.level, x.canClear])).toEqual([["claude", "recovering", false]]);
    expect(fill(r[0]!.title)).toBe("额度已恢复，正在关菜单、补投消息、续跑");
    expect(r[0]!.detail).toEqual([]);
  });
  test("4：都正常，什么都不出；读不到（null / undefined）也不出", () => {
    expect(rows(S4)).toEqual([]);
    expect(noticeRows(null, null, NOW)).toEqual([]);
    expect(noticeRows(undefined, undefined, NOW)).toEqual([]);
  });
  test("每族取最严重：Claude 线在「到提醒线」、闸开着 → 只出「用完」那一行", () => {
    expect(noticeRows(S1.lines, wallOut(), NOW).map((x) => [x.family, x.level])).toEqual([["claude", "out"]]);
  });
  test("说法：不出现禁用词，也不出现 low-priority", () => {
    const all = JSON.stringify([S1, S2, S3].flatMap(rows).map((r) => [fill(r.title), ...r.detail.map(fill)]));
    expect(BANNED_OWNER_WORDS.filter((w) => all.includes(w))).toEqual([]);
    expect(all).not.toMatch(/low-priority|订阅额度|账号用量/);
  });
});

describe("额度摘要", () => {
  const text = (s: { lines: QuotaLinesView; wall: WallResponse }) =>
    summaryParts(s.lines, s.wall, NOW)?.map((p) => `${p.family} 本周已用 ${p.pct}%${p.tag ? ` ${fill(p.tag)}` : ""}`).join(" · ") ?? null;
  test("每族百分比，到线 / 用完的后面跟状态字", () => {
    expect(text(S4)).toBe("Claude 本周已用 62% · Codex 本周已用 18%");
    expect(text(S1)).toBe("Claude 本周已用 82% 到提醒线 · Codex 本周已用 18%");
    expect(text(S2)).toBe("Claude 本周已用 100% 用完 · 10/14 15:00 重置 · Codex 本周已用 95% 不再接新活");
    expect(summaryParts(S2.lines, S2.wall, NOW)!.map((p) => p.tone)).toEqual(["error", "error"]);
    expect(summaryParts(S1.lines, S1.wall, NOW)!.map((p) => p.tone)).toEqual(["warning", null]);
  });
  test("读不到 / 两族都没读数：整行不出（null，不写「暂无」）", () => {
    expect(summaryParts(null, null, NOW)).toBeNull();
    expect(summaryParts(view([line("claude", 0, "unknown", { weekUsedPct: null })]), null, NOW)).toBeNull();
  });
});

describe("关掉", () => {
  const dismissedAfter = (closedOn: NoticeRow[], next: NoticeRow[]) => {
    const m = parseNoticeDismiss(JSON.stringify(dismissRows({}, "fp1", closedOn)));
    return next.map((r) => isRowDismissed(m, "fp1", r));
  };
  test("关掉后同严重度不再出（百分比涨了也一样）；一个关闭按钮记下卡上每一行", () => {
    expect(dismissedAfter(rows(S1), rows({ ...S1, lines: view([line("claude", 86, "warn")]) }))).toEqual([true]);
    expect(dismissedAfter(rows(S2), rows(S2))).toEqual([true, true]);
  });
  test("升级再出：到提醒线 → 不再接新活 → 用完", () => {
    expect(dismissedAfter(rows(S1), rows({ ...S1, lines: view([line("claude", 91, "stop")]) }))).toEqual([false]);
    expect(dismissedAfter(rows({ ...S1, lines: view([line("claude", 91, "stop")]) }), noticeRows(S1.lines, wallOut({ resetsAt: RESET }), NOW))).toEqual([false]);
  });
  test("同一窗口降级不再出；新的重置窗口再出", () => {
    const stop = rows({ ...S1, lines: view([line("claude", 91, "stop")]) });
    expect(dismissedAfter(stop, rows(S1))).toEqual([true]);
    expect(dismissedAfter(rows(S1), rows({ ...S1, lines: view([line("claude", 82, "warn", { resetAt: RESET + 7 * 86_400_000 })]) }))).toEqual([false]);
  });
  test("同一道闸（enteredAt 不变）换了重置时刻 = 新窗口再出；同一时刻 / 旧键迁来缺时刻的仍按这道闸认", () => {
    const at = (resetsAt: number | null) => noticeRows(null, wallOut({ resetsAt }), NOW);
    expect(dismissedAfter(at(NOW + 3_600_000), at(NOW + 24 * 3_600_000))).toEqual([false]); // 先碰 5 小时、后碰周额度：mergeReset 保留 enteredAt
    expect(dismissedAfter(at(NOW + 3_600_000), at(NOW + 3_600_000))).toEqual([true]);
    expect(dismissedAfter(at(null), at(NOW + 24 * 3_600_000))).toEqual([true]);
  });
  test("关过「用完」，开始恢复照样出一次；同一道闸关过恢复中不再出", () => {
    expect(dismissedAfter(rows(S2), rows(S3))).toEqual([false]);
    expect(dismissedAfter(rows(S3), rows(S3))).toEqual([true]);
  });
  test("按机器分开", () => {
    const m = dismissRows({}, "fp1", rows(S1));
    expect(isRowDismissed(m, "fp2", rows(S1)[0]!)).toBe(false);
  });
  test("合并（别的 tab 落盘 + 本页存不下）取并集；坏数据当没关过", () => {
    const a = dismissRows({}, "fp1", rows(S1)), b = dismissRows({}, "fp1", [rows(S2)[1]!]);
    const m = mergeNoticeDismiss(a, b);
    expect([isRowDismissed(m, "fp1", rows(S1)[0]!), isRowDismissed(m, "fp1", rows(S2)[1]!)]).toEqual([true, true]);
    for (const bad of [null, "{bad", "[1]", '{"x":[{"level":"nope","id":"lines","reset":null}]}']) expect(parseNoticeDismiss(bad)).toEqual({});
  });
});

describe("旧关闭键迁移一次", () => {
  const store = (kv: Record<string, string>) => (k: string) => (Object.hasOwn(kv, k) ? kv[k]! : null);
  const oldWarn = JSON.stringify({ "fp1|claude": { gen: `${RESET}|80/90|on`, since: 1, states: ["warn:half"] } });
  test("还没有新键：读旧提醒条（族 + 级 + 重置时刻）与旧闸横幅（这道闸）两个键，结果要写进新键", () => {
    const { map, migrated } = loadNoticeDismiss(store({ [OLD_WARNING_KEY]: oldWarn, [OLD_WALL_KEY]: `${NOW - 600_000}:active` }), "fp1");
    expect(migrated).toBe(true);
    expect(rows(S1).map((r) => isRowDismissed(map, "fp1", r))).toEqual([true]); // 旧提醒条关过的这一周提醒
    expect(rows(S2).map((r) => isRowDismissed(map, "fp1", r))).toEqual([true, false]); // 旧横幅关过的这道闸；Codex 没关过
    expect(isRowDismissed(map, "fp1", rows({ ...S1, lines: view([line("claude", 91, "stop")]) })[0]!)).toBe(false); // 升级照样出
  });
  test("已有新键：只读新键，旧键不再看（迁移只一次）", () => {
    const { map, migrated } = loadNoticeDismiss(store({ [NOTICE_DISMISS_KEY]: "{}", [OLD_WARNING_KEY]: oldWarn }), "fp1");
    expect(migrated).toBe(false);
    expect(rows(S1).map((r) => isRowDismissed(map, "fp1", r))).toEqual([false]);
  });
  test("旧键都没有：迁出空记录", () => expect(loadNoticeDismiss(store({}), "fp1")).toEqual({ map: {}, migrated: true }));
});

/** 由 tests/web-notice-merge.test.ts「额度闸横幅」describe 挪来：种类、重置时间与倒计时、排队条数、「已恢复」；重置时间不明 / 恢复中 / 没闸 */
describe("额度闸那一行（挪自 web-notice-merge）", () => {
  test("闸开着：种类与重置时刻进标题、倒计时与排队条数进明细，可以点「已恢复」", () => {
    const r = noticeRows(null, { active: true, queued: 4, wall: { kind: "weekly", enteredAt: 1, resetsAt: NOW + 32 * 3_600_000, agents: ["agent-a"] } }, NOW)[0]!;
    expect(r).toMatchObject({ family: "claude", level: "out", canClear: true });
    expect(fill(r.title)).toBe("Claude 本周额度用完，10/15 20:00 重置");
    expect(r.detail.map(fill)).toEqual(["约 32 小时后", "排队 4 条 agent 消息，恢复后自动送达"]);
  });
  test("重置时间不明 / 恢复中 / 没闸", () => {
    const unknown = noticeRows(null, { active: true, queued: 0, wall: { kind: "unknown", enteredAt: 1, resetsAt: null } }, NOW)[0]!;
    expect([fill(unknown.title), unknown.detail[0]!.text]).toEqual(["Claude 额度用完", "重置时间未知"]);
    const rec = noticeRows(null, { active: false, wall: { kind: "weekly", enteredAt: 1, recovering: true } }, NOW)[0]!;
    expect(rec).toMatchObject({ level: "recovering", canClear: false, id: "wall:1" });
    expect(noticeRows(null, { active: false, wall: { kind: "weekly", enteredAt: 1, recovering: false } }, NOW)).toEqual([]);
    expect(noticeRows(null, { active: false, wall: null }, NOW)).toEqual([]);
    expect(noticeRows(null, null, NOW)).toEqual([]);
  });
});
