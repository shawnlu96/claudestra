/**
 * 团队概览「主场镜像过期」按详情取回时刻判落后，不按详情内容的 observedAt（它比取回早一个推送周期，按它判会误报）。
 * 读详情失败超时（回退旧缓存）且列表在更新仍判过期；排队等重拉（waiting）的不按落后判；主场停推按详情 observedAt 判。
 * fake session + 可注入时钟，按 5 秒一轮列表、10 秒一轮推送模拟。
 */
import { expect, test } from "bun:test";
import { mirrorFact, teamOverview } from "@/features/collab/team-source-adapter";
import { sharedCollabSource, DETAIL_BEHIND_MS, DETAIL_REFRESH_MS, POLL_MS } from "@/features/collab/team-source-shared";
import { MIRROR_FRESH_MS } from "@/features/collab/mirror-fresh";
import { generateTeamFixture } from "@/features/collab/shared/team-fixture-gen";
import { ApiError } from "@/lib/api/client";
import { SharedLedgerSession, type FeatureDetail, type FeatureList, type Transport } from "@/lib/api/shared-ledger";

const PUSH_MS = 10_000, PUSH_PER_ROUND = 12;

/** 中心：每 10 秒一轮推送，每轮按最久没推的先推至多 12 个；列表 / 详情读到的都是读那一刻中心的投影 */
function center() {
  const fx = generateTeamFixture({ features: 26 });
  const t0 = fx.now;
  let t = t0, seq = 1, nextPush = t0, fail: ((id: string) => Error | null) | null = null, pushing = true;
  const base = new Map(fx.details.map((d) => [d.feature.id, d]));
  type P = NonNullable<FeatureList["features"][number]["projection"]>;
  const proj = new Map<string, P>(fx.list.features.map((f) => [f.id, { sourceInstanceId: "home", sourceSeq: seq++, observedAt: t0, receivedAt: t0 }]));
  const pushed = new Map(fx.list.features.map((f, i) => [f.id, i]));
  let order = 26;
  const pushRound = () => {
    const ids = [...pushed.keys()].sort((a, b) => pushed.get(a)! - pushed.get(b)!).slice(0, PUSH_PER_ROUND);
    for (const id of ids) { proj.set(id, { sourceInstanceId: "home", sourceSeq: seq++, observedAt: t, receivedAt: t }); pushed.set(id, order++); }
  };
  let serverSeq = fx.list.serverSeq;
  const list = (): FeatureList => ({ ...fx.list, serverSeq, features: fx.list.features.map((f) => ({ ...f, projection: proj.get(f.id)! })) });
  const transport: Transport = {
    list: async () => list(),
    detail: async (id) => {
      const e = fail?.(id);
      if (e) throw e;
      const d = structuredClone(base.get(id)!);
      d.feature = { ...d.feature, projection: proj.get(id)! };
      return d;
    },
    command: async () => { throw new Error("unused"); },
    receipt: async (id) => ({ status: "unknown", requestId: id }),
  };
  const identity = { center: "c", team: fx.team, person: "p", project: fx.project, machine: "m" };
  const src = sharedCollabSource(new SharedLedgerSession(identity, transport), "team", "label", POLL_MS, { now: () => t });
  /** 读一轮：按注入的时钟、带取回时刻重判概览镜像 */
  const round = async () => {
    await src.overview(new AbortController().signal);
    const got = src.last()!;
    return teamOverview(got.list, got.details, t, got.waiting, got.fetchedAt).ov.mirror!;
  };
  return { fx, src, round, get t() { return t - t0; },
    /** 前进一轮列表轮询；到点的推送轮先推 */
    advance: () => {
      t += POLL_MS;
      while (pushing && nextPush <= t) { pushRound(); nextPush += PUSH_MS; serverSeq++; }
    },
    /** 主场停推（列表也不再前进） */
    stop: () => { pushing = false; },
    lagOf: (id: string) => t - proj.get(id)!.observedAt,
    fail: (f: ((id: string) => Error | null) | null) => { fail = f; } };
}
const staleCount = (m: readonly { mirror: string | null }[]) => m.filter((x) => x.mirror === "stale").length;

test("N8A8C-1 中心每 10 秒推至多 12 个、详情 observedAt 落后 0–30 秒，列表 5 秒 / 详情 60 秒 / 每轮上限 8，10 分钟内概览过期计数始终 0", async () => {
  const c = center();
  const counts: { t: number; n: number; own: number }[] = [];
  let maxLag = 0;
  for (;;) {
    const m = await c.round();
    counts.push({ t: c.t, n: staleCount(m), own: staleCount(c.src.last()!.team.ov.mirror!) });
    for (const f of c.fx.list.features) maxLag = Math.max(maxLag, c.lagOf(f.id));
    if (c.t >= 10 * 60_000) break;
    c.advance();
  }
  expect(counts.length).toBe(121);
  // 推送节奏确实让 observedAt 落后到 20 秒以上（不是每轮全推的理想中心）
  expect(maxLag).toBeGreaterThanOrEqual(20_000);
  expect(maxLag).toBeLessThanOrEqual(30_000);
  // 适配层重判与数据源自己转好的那份（按注入时钟）一致，都没有过期
  expect(counts.filter((x) => x.n > 0 || x.own > 0)).toEqual([]);
});

test("N8A8C-1 旧口径（按详情内容 observedAt 比列表）在同样节奏下会报过期：确认模拟复现了 PAGEOK r6", async () => {
  const c = center();
  let worst = 0;
  for (;;) {
    await c.round();
    const got = c.src.last()!;
    const t = got.team.ov.now;
    const old = got.list.features.filter((f) => {
      const p = got.details.get(f.id)?.feature.projection;
      return !!p && !got.waiting.has(f.id) && f.projection!.observedAt - p.observedAt > DETAIL_BEHIND_MS;
    }).length;
    worst = Math.max(worst, old);
    expect(t - c.fx.now).toBe(c.t);
    if (c.t >= 10 * 60_000) break;
    c.advance();
  }
  expect(worst).toBeGreaterThan(0);
});

for (const [name, err] of [["429", () => new ApiError("rate limited", 429, { error: "rate limited", retryAfter: 1 })], ["500", () => new ApiError("boom", 500, { error: "boom" })]] as const) {
  test(`N8A8C-2 某 feature 详情连续 ${name} 超过 65 秒、列表在更新：计为过期；读回成功后下一轮恢复`, async () => {
    const c = center();
    const bad = c.fx.list.features[3]!.id, idx = 3;
    expect(staleCount(await c.round())).toBe(0);
    const okAt = c.src.last()!.fetchedAt.get(bad)!;
    c.fail((id) => (id === bad ? err() : null));
    const at: { t: number; stale: boolean }[] = [];
    while (c.t < 120_000) {
      c.advance();
      const m = await c.round();
      // 读失败不更新取回时刻
      expect(c.src.last()!.fetchedAt.get(bad)).toBe(okAt);
      at.push({ t: c.t, stale: m[idx]!.mirror === "stale" });
    }
    for (const r of at) expect(r).toEqual({ t: r.t, stale: r.t > DETAIL_BEHIND_MS });
    c.fail(null);
    c.advance();
    expect((await c.round())[idx]!.mirror).toBe("fresh");
  });
}

test("N8A8C-3 主场真停了（详情 observedAt 超过 10 分钟）：计为过期，即使详情刚取回", async () => {
  const c = center();
  expect(staleCount(await c.round())).toBe(0);
  c.stop();
  while (c.t < MIRROR_FRESH_MS + 40_000) { c.advance(); await c.round(); }
  const m = await c.round();
  expect(staleCount(m)).toBe(26);
  expect(m.every((x) => x.freshUntil === null && x.observedAt !== null)).toBe(true);
});

test("N8A8C 适配层边界：按取回时刻判，取回 65 秒内不算、多 1 毫秒算；列表不比详情新不算；排队中不算；详情 observedAt 超过 10 分钟仍算", () => {
  const fx = generateTeamFixture({ features: 1 });
  const d = fx.details[0]!, now = fx.now;
  const p = { sourceInstanceId: "home", sourceSeq: 1, observedAt: now - 30_000, receivedAt: now - 30_000 };
  const shown: FeatureDetail = { ...d, feature: { ...d.feature, projection: p } };
  const list = (dt: number, seq = 99) => ({ ...d.feature, projection: { ...p, sourceSeq: seq, observedAt: now + dt } });
  // 详情内容落后 95 秒，但 60 秒前刚取回：不算（main 上这里是过期）
  // 列表领先时新鲜期截到领先起点 + 65 秒（N8A8G r2：退避中页面走表也要按时翻过期）
  expect(mirrorFact(list(65_000), shown, now + 60_000, false, now)).toEqual({ mirror: "fresh", freshUntil: now + DETAIL_BEHIND_MS, observedAt: p.observedAt });
  expect(mirrorFact(list(65_000), shown, now + DETAIL_BEHIND_MS, false, now).mirror).toBe("fresh");
  expect(mirrorFact(list(65_000), shown, now + DETAIL_BEHIND_MS + 1, false, now).mirror).toBe("stale");
  // 只有 sourceSeq 更大也算列表更新
  expect(mirrorFact({ ...d.feature, projection: { ...p, sourceSeq: 2 } }, shown, now + DETAIL_BEHIND_MS + 1, false, now).mirror).toBe("stale");
  // 列表不比详情新：取回再久也不算落后
  expect(mirrorFact({ ...d.feature, projection: p }, shown, now + DETAIL_REFRESH_MS * 3, false, now).mirror).toBe("fresh");
  // 排队中不按落后判
  expect(mirrorFact(list(65_000), shown, now + DETAIL_BEHIND_MS + 1, true, now).mirror).toBe("fresh");
  // 刚取回，但详情 observedAt 超过 10 分钟：主场停了
  const old = { ...p, observedAt: now - MIRROR_FRESH_MS - 1 };
  expect(mirrorFact(list(0), { ...d, feature: { ...d.feature, projection: old } }, now, false, now).mirror).toBe("stale");
});
