/**
 * team-project-N8F：主场镜像新鲜窗口 30 秒 → 10 分钟（mirror-fresh.ts 一个常量），过期写「主场 N 分钟前同步」。
 * 旧红新绿：main 上 observedAt 5 分钟前就标「主场镜像过期」、进度按 0；修完窗口内不标过期、进度正常。纯数据，不碰网络。
 */
import { expect, test } from "bun:test";
import { MIRROR_FRESH_MS, mirrorAgo, mirrorLine } from "@/features/collab/mirror-fresh";
import { progress, stale } from "@/features/collab/shared/shared-model";
import { mirrorFact, teamOverview } from "@/features/collab/team-source-adapter";
import { mirrorAt, mirrorCounts, teamNote } from "@/features/collab/collab-model";
import { generateTeamFixture } from "@/features/collab/shared/team-fixture-gen";
import { fillParams } from "@/lib/i18n-fill";
import { sharedLedgerTr } from "@/lib/i18n-dict-shared-ledger";
import type { FeatureDetail } from "@/lib/api/shared-ledger";

const fx = generateTeamFixture();
const MIN = 60_000;
/** observedAt = fx.now - ago 的那份详情（列表也用它，不触发「列表比详情新」） */
const aged = (ago: number): FeatureDetail => {
  const d = structuredClone(fx.details[0]!);
  d.feature.projection = { ...d.feature.projection!, observedAt: fx.now - ago };
  d.feature.counts = { total: 4, completed: 2, blocked: 0, missing: 0 };
  return d;
};
const ov = (d: FeatureDetail) => teamOverview({ ...fx.list, features: [d.feature] }, new Map([[d.feature.id, d]]), fx.now).ov;
const boundTask = (d: FeatureDetail) => ov(d).tasks.find((t) => t.team)!;

test("验收 1：observedAt 5 分钟前：规划面板「主场镜像最新」、进度正常、卡片不标过期、v4 计数为 fresh", () => {
  const d = aged(5 * MIN);
  expect(stale(d.feature, fx.now)).toBe(false);
  expect(progress(d.feature, fx.now)).toBe(2);
  expect(mirrorLine(d.feature.projection!.observedAt, fx.now, fillParams)).toBe("主场镜像最新");
  expect(teamNote(boundTask(d), fx.now)).toBe("");
  expect(mirrorCounts(ov(d).mirror!, fx.now)).toEqual({ stale: 0, fresh: 1, none: 0 });
});

test("验收 2：observedAt 11 分钟前「主场 11 分钟前同步」、进度按 0；90 分钟前「主场 1 小时前同步」", () => {
  const d = aged(11 * MIN);
  expect(stale(d.feature, fx.now)).toBe(true);
  expect(progress(d.feature, fx.now)).toBe(0);
  expect(mirrorLine(d.feature.projection!.observedAt, fx.now, fillParams)).toBe("主场 11 分钟前同步");
  expect(teamNote(boundTask(d), fx.now)).toBe("主场 11 分钟前同步");
  expect(mirrorCounts(ov(d).mirror!, fx.now)).toEqual({ stale: 1, fresh: 0, none: 0 });
  const h = aged(90 * MIN);
  expect(mirrorLine(h.feature.projection!.observedAt, fx.now, fillParams)).toBe("主场 1 小时前同步");
  expect(teamNote(boundTask(h), fx.now)).toBe("主场 1 小时前同步");
  expect(mirrorAgo(fx.now - 11 * MIN - 59_000, fx.now, fillParams)).toBe("主场 11 分钟前同步");
});

test("验收 2：读到时新鲜、之后随时间过期：卡片按 observedAt 写多久前同步", () => {
  const t = boundTask(aged(5 * MIN));
  expect(teamNote(t, fx.now + 6 * MIN)).toBe("主场 11 分钟前同步");
});

test("验收 3：无 projection 仍是「尚无执行镜像」，卡片不标、计数 none", () => {
  const d = aged(0);
  d.feature.projection = null;
  expect(mirrorLine(null, fx.now, fillParams)).toBe("尚无执行镜像");
  expect(stale(d.feature, fx.now)).toBe(false);
  expect(mirrorFact(d.feature, d, fx.now)).toEqual({ mirror: null, freshUntil: null, observedAt: null });
  expect(mirrorCounts(ov(d).mirror!, fx.now)).toEqual({ stale: 0, fresh: 0, none: 1 });
});

test("边界：恰好 10 分钟（600000ms）仍新鲜", () => {
  const d = aged(600_000);
  expect([stale(d.feature, fx.now), mirrorFact(d.feature, d, fx.now).mirror, progress(d.feature, fx.now)]).toEqual([false, "fresh", 2]);
  expect(mirrorAt(mirrorFact(aged(0).feature, aged(0), fx.now), fx.now + 600_000)).toBe("fresh");
});

test("边界：600001ms 即过期", () => {
  const d = aged(600_001);
  expect([stale(d.feature, fx.now), mirrorFact(d.feature, d, fx.now).mirror, progress(d.feature, fx.now)]).toEqual([true, "stale", 0]);
  expect(mirrorAt(mirrorFact(aged(0).feature, aged(0), fx.now), fx.now + 600_001)).toBe("stale");
});

test("验收 4：shared-model stale 与 adapter mirrorFact / mirrorAt 同一常量，窗口边界两边结论一致", () => {
  expect(MIRROR_FRESH_MS).toBe(10 * MIN);
  for (const ago of [0, 30_001, 5 * MIN, MIRROR_FRESH_MS, MIRROR_FRESH_MS + 1, 11 * MIN, 90 * MIN]) {
    const d = aged(ago);
    const fact = mirrorFact(d.feature, d, fx.now);
    const atRead = fact.mirror === "stale";
    expect({ ago, shared: stale(d.feature, fx.now), adapter: atRead }).toEqual({ ago, shared: ago > MIRROR_FRESH_MS, adapter: ago > MIRROR_FRESH_MS });
    // 读到时新鲜的：随时间重判也和 stale 同一刻翻
    const fresh = mirrorFact(aged(0).feature, aged(0), fx.now);
    expect(mirrorAt(fresh, fx.now + ago) === "stale").toBe(stale(aged(0).feature, fx.now + ago));
  }
});

test("英文：过期句走 collab 词条；面板其余词仍用共享台账字典", () => {
  const en = sharedLedgerTr("en");
  expect(mirrorLine(null, fx.now, en)).toBe("No execution mirror yet");
  expect(mirrorLine(fx.now - MIN, fx.now, en)).toBe("Home mirror is fresh");
  const collabEn = (s: string, p?: Record<string, string | number>) =>
    fillParams(({ "主场 {n} 分钟前同步": "Home synced {n} min ago", "主场 {n} 小时前同步": "Home synced {n} h ago" } as Record<string, string>)[s] ?? s, p);
  expect(mirrorLine(fx.now - 11 * MIN, fx.now, en, collabEn)).toBe("Home synced 11 min ago");
  expect(mirrorLine(fx.now - 90 * MIN, fx.now, en, collabEn)).toBe("Home synced 1 h ago");
});
