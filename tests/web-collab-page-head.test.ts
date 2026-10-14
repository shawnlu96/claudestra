/**
 * UXHOME1：协作视图页头「团队版 · …」那一行的状态与文字（web/features/collab/collab-head-i18n.ts），纯数据。
 * 镜像两种照规格「对照基准」：全部新鲜，以及 2 个 feature 过期；再加还没有任何镜像、走表越过新鲜期。挂 React 的在 tests/web-dom-team-parity-head.test.ts。
 */
import { expect, test } from "bun:test";
import { headMirror, headMirrorText, headTr, HEAD_WORDS } from "@/features/collab/collab-head-i18n";
import type { MirrorFact } from "@/features/collab/collab-model";
import { MIRROR_FRESH_MS } from "@/features/collab/mirror-fresh";

const NOW = Date.UTC(2026, 9, 14, 3, 0);
const min = (n: number) => NOW - n * 60_000;
const fresh = (agoMin: number): MirrorFact => ({ mirror: "fresh", freshUntil: min(agoMin) + MIRROR_FRESH_MS, observedAt: min(agoMin) });
const stale = (agoMin: number): MirrorFact => ({ mirror: "stale", freshUntil: null, observedAt: min(agoMin) });
const none: MirrorFact = { mirror: null, freshUntil: null, observedAt: null };
const items = ["登录改版", "账单导出", "搜索提速", "通知中心"].map((title, i) => ({ id: `f${i}`, title, oneLine: "" }));
const zh = headTr("zh"), en = headTr("en");
const line = (mirror: readonly MirrorFact[] | undefined, now = NOW, h = zh) => {
  const m = headMirror({ mirror, items }, now);
  return `${h(HEAD_WORDS.team)} · ${headMirrorText(m, now, h)}`;
};

test("[验收线 5] 全部新鲜：『团队版 · N 分钟前同步』，N 取各份里最早的那个", () => {
  expect(line([fresh(2), fresh(7), fresh(4)])).toBe("团队版 · 7 分钟前同步");
  expect(headMirror({ mirror: [fresh(2), fresh(7)], items }, NOW)).toEqual({ state: "fresh", observedAt: min(7) });
  // 有的还没收到（只做了规划的）不拦着说已收到的那几份多久前同步的
  expect(line([fresh(3), none])).toBe("团队版 · 3 分钟前同步");
});

test("[验收线 5] 不足一分钟写『团队版 · 刚刚同步』，不写『0 分钟前』；满一分钟照常写分钟", () => {
  expect(line([fresh(0)])).toBe("团队版 · 刚刚同步");
  expect(headMirrorText({ state: "fresh", observedAt: NOW - 59_000 }, NOW, zh)).toBe("刚刚同步");
  expect(headMirrorText({ state: "fresh", observedAt: null }, NOW, zh)).toBe("刚刚同步");
  expect(line([fresh(1)])).toBe("团队版 · 1 分钟前同步");
  expect(line([fresh(0)], NOW, en)).toBe("Team version · synced just now");
});

test("[验收线 5] 有过期：写过期个数，名单是过期的那几个（与事项同序）；新鲜的不在名单里", () => {
  const mirror = [fresh(1), stale(25), fresh(2), stale(90)];
  expect(line(mirror)).toBe("团队版 · 2 个模块的进度可能不是最新的");
  expect(headMirror({ mirror, items }, NOW)).toEqual({ state: "stale", names: ["账单导出", "通知中心"] });
});

test("[验收线 5] 还没有任何一份：『团队版 · 还没收到任务所在机器的进度』；总览没带镜像字段也按没收到", () => {
  expect(line([none, none])).toBe("团队版 · 还没收到任务所在机器的进度");
  expect(line([])).toBe("团队版 · 还没收到任务所在机器的进度");
  expect(line(undefined)).toBe("团队版 · 还没收到任务所在机器的进度");
});

test("读到时新鲜、页面走表越过新鲜期：同一份数据改报过期（任务所在的机器停了也不会有新数据来触发重读）", () => {
  const mirror = [fresh(9)];
  expect(line(mirror)).toBe("团队版 · 9 分钟前同步");
  const later = NOW + 2 * 60_000;
  expect(headMirror({ mirror, items }, later)).toEqual({ state: "stale", names: ["登录改版"] });
  expect(line(mirror, later)).toBe("团队版 · 1 个模块的进度可能不是最新的");
});

test("满 60 分钟写小时（mirror-fresh.ts mirrorAgo 的口径）；英文有译文", () => {
  expect(headMirrorText({ state: "fresh", observedAt: min(125) }, NOW, zh)).toBe("2 小时前同步");
  expect(line([fresh(7)], NOW, en)).toBe("Team version · synced 7 min ago");
  expect(line([stale(30), stale(40)], NOW, en)).toBe("Team version · Progress may be out of date for 2 modules");
  expect(line([none], NOW, en)).toBe("Team version · No progress received from the task's machine yet");
  expect([en(HEAD_WORDS.planTab), en(HEAD_WORDS.planSub)]).toEqual(["Plans & proposals", "Team plans and member proposals"]);
});

test("[PM 补 3] 页头的每一种文字、标签名与副标题都不出内部词", () => {
  const texts = [line([fresh(7)]), line([fresh(0)]), line([stale(30), fresh(1)]), line([none]), headMirrorText({ state: "fresh", observedAt: min(125) }, NOW, zh),
    zh(HEAD_WORDS.planTab), zh(HEAD_WORDS.planSub), zh(HEAD_WORDS.showStale)];
  for (const text of texts) for (const bad of ["主场", "镜像", "feature", "spec", "parked", "可执行", "就绪可开", "复述"]) {
    expect({ text, bad, hit: text.includes(bad) }).toEqual({ text, bad, hit: false });
  }
});
