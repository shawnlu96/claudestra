/**
 * team-project-N8A8G：概览「落后列表」的 65 秒从页面第一次看到列表领先显示详情时算起，不把本机空闲时间算进去。
 * 旧红新绿：main 按详情取回时刻（fetchedAt）计时，空闲几分钟后列表一前进、这一轮详情没读到（429）就立刻判过期。
 * 只看数据源自己转好的那份概览（last().team，按注入时钟），fake session 按 5 秒一轮模拟。
 */
import { expect, test } from "bun:test";
import { sharedCollabSource, DETAIL_BEHIND_MS, DETAIL_REFRESH_PER_ROUND, POLL_MS } from "@/features/collab/team-source-shared";
import { MIRROR_FRESH_MS } from "@/features/collab/mirror-fresh";
import { mirrorAt } from "@/features/collab/collab-model";
import { generateTeamFixture } from "@/features/collab/shared/team-fixture-gen";
import { ApiError } from "@/lib/api/client";
import { SharedLedgerSession, type FeatureList, type Transport } from "@/lib/api/shared-ledger";

/** 26 个 feature；advance() 列表水位全前进（本机来了新事件）；idle() 只走时钟、列表不动（本机空闲，推送按设计不发） */
function world() {
  const fx = generateTeamFixture({ features: 26 });
  const t0 = fx.now;
  let t = t0, seq = 1, retryAfter = 1, fail: ((id: string) => boolean) | null = null;
  let list: FeatureList = fx.list;
  const base = new Map(fx.details.map((d) => [d.feature.id, d]));
  const tick = () => {
    seq++;
    list = { ...list, serverSeq: list.serverSeq + 1,
      features: fx.list.features.map((f) => ({ ...f, projection: { sourceInstanceId: "home", sourceSeq: seq, observedAt: t, receivedAt: t } })) };
  };
  tick();
  const transport: Transport = {
    list: async () => list,
    detail: async (id) => {
      if (fail?.(id)) throw new ApiError("rate limited", 429, { error: "rate limited", retryAfter });
      const d = structuredClone(base.get(id)!);
      d.feature = { ...d.feature, projection: list.features.find((f) => f.id === id)!.projection };
      return d;
    },
    command: async () => { throw new Error("unused"); },
    receipt: async (id) => ({ status: "unknown", requestId: id }),
  };
  const identity = { center: "c", team: fx.team, person: "p", project: fx.project, machine: "m" };
  const src = sharedCollabSource(new SharedLedgerSession(identity, transport), "team", "label", POLL_MS, { now: () => t });
  /** 读一轮，返回数据源自己按注入时钟判的概览镜像 */
  const round = async () => {
    await src.overview(new AbortController().signal);
    return src.last()!.team.ov.mirror!;
  };
  return { fx, src, round, get t() { return t - t0; },
    advance: () => { t += POLL_MS; tick(); },
    idle: () => { t += POLL_MS; },
    fail: (f: ((id: string) => boolean) | null, after = 1) => { fail = f; retryAfter = after; } };
}
const staleCount = (m: readonly { mirror: string | null }[]) => m.filter((x) => x.mirror === "stale").length;

test("N8A8G-1 首轮缓存 → 列表空闲 6 分钟 → 列表前进、该轮详情 429 一次 → 下一轮读成功：全程概览 stale 计数恒 0", async () => {
  const w = world();
  const counts: { t: number; n: number }[] = [];
  counts.push({ t: w.t, n: staleCount(await w.round()) });
  while (w.t < 6 * 60_000) { w.idle(); counts.push({ t: w.t, n: staleCount(await w.round()) }); }
  // 空闲期间列表与详情一致：不计时
  expect(w.src.last()!.behindSince.size).toBe(0);
  // 空闲后第一条事件：列表前进，这一轮第一个详情请求 429（本轮剩下的停发）
  let first = true;
  w.fail(() => { const hit = first; first = false; return hit; });
  w.advance();
  const m = await w.round();
  counts.push({ t: w.t, n: staleCount(m) });
  const got = w.src.last()!;
  // 确有详情没读到、落后列表（main 上 now − fetchedAt 已 6 分钟，这一轮就判过期）
  expect(got.list.features.filter((f) => got.behindSince.get(f.id) === got.team.ov.now && !got.waiting.has(f.id)).length).toBeGreaterThan(0);
  expect(got.waiting.size).toBe(26 - DETAIL_REFRESH_PER_ROUND);
  w.fail(null);
  // 之后列表继续每 5 秒前进 2 分钟：各轮按上限补完、60 秒到期重拉
  while (w.t < 8 * 60_000) { w.advance(); counts.push({ t: w.t, n: staleCount(await w.round()) }); }
  expect(counts.filter((c) => c.n > 0)).toEqual([]);
  // 本机再空闲：到期重拉读成功、追上列表的 feature 清掉计时起点
  for (let i = 0; i < 20 && w.src.last()!.behindSince.size > 0; i++) { w.idle(); expect(staleCount(await w.round())).toBe(0); }
  expect(w.src.last()!.behindSince.size).toBe(0);
});

test("N8A8G-2 空闲后列表前进、某 feature 详情连续 429 超过 65 秒：计为过期；读回成功后下一轮恢复", async () => {
  const w = world();
  const idx = 3, bad = w.fx.list.features[idx]!.id;
  expect(staleCount(await w.round())).toBe(0);
  while (w.t < 6 * 60_000) { w.idle(); await w.round(); }
  w.fail((id) => id === bad);
  const start = w.t;
  const at: { dt: number; stale: boolean }[] = [];
  while (w.t - start < 100_000) {
    w.advance();
    const m = await w.round();
    at.push({ dt: w.t - start, stale: m[idx]!.mirror === "stale" });
  }
  // 第一次看到列表领先 = 空闲后第一轮（dt = 5 秒）：从那时起超过 65 秒才算
  expect(w.src.last()!.behindSince.get(bad)).toBe(w.fx.now + start + POLL_MS);
  for (const r of at) expect(r).toEqual({ dt: r.dt, stale: r.dt - POLL_MS > DETAIL_BEHIND_MS });
  w.fail(null);
  w.advance();
  expect((await w.round())[idx]!.mirror).toBe("fresh");
  expect(w.src.last()!.behindSince.has(bad)).toBe(false);
});

test("N8A8G-2b 列表只前进一次、详情 429 退避 60 秒（期间不重读）：页面走表（mirrorAt）在领先超过 65 秒时翻成过期", async () => {
  const w = world();
  const idx = 3, bad = w.fx.list.features[idx]!.id;
  expect(staleCount(await w.round())).toBe(0);
  while (w.t < 6 * 60_000) { w.idle(); await w.round(); }
  w.fail((id) => id === bad, 60);
  w.advance();
  const m = (await w.round())[idx]!;
  const since = w.src.last()!.behindSince.get(bad)!;
  expect(w.src.last()!.waiting.has(bad)).toBe(false);
  expect(m.mirror).toBe("fresh");
  expect(mirrorAt(m, since + DETAIL_BEHIND_MS)).toBe("fresh");
  expect(mirrorAt(m, since + DETAIL_BEHIND_MS + 1)).toBe("stale");
  expect(mirrorAt(m, since + 90_000)).toBe("stale");
  // 列表不再前进、退避中不重读：每轮转出的概览照样按领先起点走表
  const at: { dt: number; stale: boolean }[] = [];
  while (w.t - (since - w.fx.now) < 100_000) {
    w.idle();
    const r = (await w.round())[idx]!;
    const now = w.fx.now + w.t;
    at.push({ dt: now - since, stale: mirrorAt(r, now) === "stale" });
  }
  for (const r of at) expect(r).toEqual({ dt: r.dt, stale: r.dt > DETAIL_BEHIND_MS });
});

test("N8A8G-3 数据源自己的概览：主场停推（详情 observedAt 超过 10 分钟）仍按 N8F 判过期，空闲不计落后不影响它", async () => {
  const w = world();
  expect(staleCount(await w.round())).toBe(0);
  while (w.t < MIRROR_FRESH_MS) { w.idle(); expect(staleCount(await w.round())).toBe(0); }
  w.idle();
  const m = await w.round();
  expect(staleCount(m)).toBe(26);
  expect(w.src.last()!.behindSince.size).toBe(0);
});
