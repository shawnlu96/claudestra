/**
 * team-project-N8A8B：团队概览「主场镜像过期」不因详情的有意重拉间隔误报。
 * 水位（sourceSeq / observedAt）是本机全局事件号，列表每 5 秒一轮都比详情新；详情水位变时 60 秒才重拉一次。
 * 旧红新绿：main 上两次重拉之间的 feature 全计为过期；修完只有落后超过 DETAIL_REFRESH_MS + POLL_MS（读失败回退旧缓存）
 * 或详情自己的 observedAt 超过 10 分钟才计为过期。fake session + 可注入时钟，按 5 秒一轮模拟。
 */
import { expect, test } from "bun:test";
import { mirrorFact, teamOverview } from "@/features/collab/team-source-adapter";
import { sharedCollabSource, DETAIL_REFRESH_MS, POLL_MS } from "@/features/collab/team-source-shared";
import { MIRROR_FRESH_MS } from "@/features/collab/mirror-fresh";
import { generateTeamFixture } from "@/features/collab/shared/team-fixture-gen";
import { ApiError } from "@/lib/api/client";
import { SharedLedgerSession, type FeatureDetail, type FeatureList, type Transport } from "@/lib/api/shared-ledger";

/** 26 个 feature；advance() 让列表水位全前进；详情读到的是读那一刻中心的投影 */
function world() {
  const fx = generateTeamFixture({ features: 26 });
  const t0 = fx.now;
  let t = t0, seq = 1, fail: ((id: string) => boolean) | null = null, reversed = false;
  let list: FeatureList = fx.list;
  const base = new Map(fx.details.map((d) => [d.feature.id, d]));
  const tick = () => {
    seq++;
    const features = fx.list.features.map((f) => ({ ...f,
      projection: { sourceInstanceId: "home", sourceSeq: seq, observedAt: t, receivedAt: t } }));
    list = { ...list, serverSeq: list.serverSeq + 1, features: reversed ? features.reverse() : features };
  };
  tick();
  const transport: Transport = {
    list: async () => list,
    detail: async (id) => {
      if (fail?.(id)) throw new ApiError("rate limited", 429, { error: "rate limited", retryAfter: 1 });
      const d = structuredClone(base.get(id)!);
      d.feature = { ...d.feature, projection: list.features.find((f) => f.id === id)!.projection };
      return d;
    },
    command: async () => { throw new Error("unused"); },
    receipt: async (id) => ({ status: "unknown", requestId: id }),
  };
  const identity = { center: "c", team: fx.team, person: "p", project: fx.project, machine: "m" };
  const src = sharedCollabSource(new SharedLedgerSession(identity, transport), "team", "label", POLL_MS, { now: () => t });
  /** 读一轮，按注入的时钟重判概览镜像 */
  const round = async () => {
    await src.overview(new AbortController().signal);
    const got = src.last()!;
    return teamOverview(got.list, got.details, t, got.waiting).ov.mirror!;
  };
  /** 同一轮按 feature id 取镜像（列表顺序可能变） */
  const byId = async () => {
    const m = await round(), features = src.last()!.list.features;
    return new Map(features.map((f, i) => [f.id, m[i]!]));
  };
  return { fx, round, byId, get t() { return t - t0; },
    /** 列表顺序反转（同样的 feature、同样的投影），下一次 advance 起生效 */
    reverse: () => { reversed = true; },
    advance: (ms = POLL_MS) => { t += ms; tick(); },
    /** 只前进时钟，主场没新事件 */
    idle: (ms: number) => { t += ms; },
    fail: (f: ((id: string) => boolean) | null) => { fail = f; } };
}
const staleCount = (m: readonly { mirror: string | null }[]) => m.filter((x) => x.mirror === "stale").length;

test("N8A8B-1 列表每 5 秒前进、详情每 60 秒重拉一次（打散在各轮），5 分钟内概览 stale 计数始终 0", () => {
  // 纯适配层：26 个 feature 的详情各自按 60 秒重拉，最晚的那个落后列表 60 秒
  const fx = generateTeamFixture({ features: 26 });
  const fetchedAt = new Map(fx.list.features.map((f, i) => [f.id, fx.now - (i % 12) * POLL_MS]));
  const proj = (at: number) => ({ sourceInstanceId: "home", sourceSeq: 1000 + at / POLL_MS, observedAt: at, receivedAt: at });
  for (let at = fx.now; at <= fx.now + 5 * 60_000; at += POLL_MS) {
    const list: FeatureList = { ...fx.list, features: fx.list.features.map((f) => ({ ...f, projection: proj(at) })) };
    const details = new Map<string, FeatureDetail>();
    for (const d of fx.details) {
      const id = d.feature.id;
      if (at - fetchedAt.get(id)! >= DETAIL_REFRESH_MS) fetchedAt.set(id, at);
      const seen = fetchedAt.get(id)!;
      details.set(id, { ...d, feature: { ...d.feature, projection: proj(seen) } });
    }
    expect(staleCount(teamOverview(list, details, at).ov.mirror!)).toBe(0);
  }
});

test("N8A8B-1b 真实取数节奏（并发 2、每轮上限 8、60 秒到期）：首轮 26 个同时到期要排 4 轮，5 分钟内概览 stale 计数始终 0", async () => {
  const w = world();
  const counts: { t: number; n: number }[] = [];
  for (;;) {
    counts.push({ t: w.t, n: staleCount(await w.round()) });
    if (w.t >= 5 * 60_000) break;
    w.advance();
  }
  expect(counts.length).toBe(61);
  // 首轮 26 个同时读到 → 60 秒时同时到期，每轮上限 8：第 70 秒那轮还剩 2 个在排队（落后 70 秒，但没发过请求、不是读失败），不算过期
  expect(counts.filter((c) => c.n > 0)).toEqual([]);
});

test("N8A8B-1c 排队中（waiting）的 feature 轮到时撞 429 并持续：落后超过 65 秒计为过期；读回成功后下一轮恢复", async () => {
  const w = world();
  // 首轮同时缓存、60 秒同时到期，按列表顺序每轮 8 个：最后一个第 75 秒才轮到，60~70 秒在排队
  const idx = w.fx.list.features.length - 1, bad = w.fx.list.features[idx]!.id;
  expect(staleCount(await w.round())).toBe(0);
  w.fail((id) => id === bad);
  const at: { t: number; stale: boolean }[] = [];
  for (;;) {
    w.advance();
    at.push({ t: w.t, stale: (await w.round())[idx]!.mirror === "stale" });
    if (w.t >= 100_000) break;
  }
  // 排队时（落后 70 秒）不算；第 75 秒轮到读失败回退缓存（落后 75 秒 > 65 秒）起算过期，429 持续就一直过期
  expect(at.some((r) => r.t === DETAIL_REFRESH_MS + 2 * POLL_MS && !r.stale)).toBe(true);
  for (const r of at) expect(r.stale).toBe(r.t >= DETAIL_REFRESH_MS + 3 * POLL_MS);
  w.fail(null);
  w.advance();
  expect((await w.round())[idx]!.mirror).toBe("fresh");
});

test("N8A8B-2 某 feature 详情连续 429 超过 65 秒且列表更新：计为过期；读回成功后下一轮恢复", async () => {
  const w = world();
  const bad = w.fx.list.features[3]!.id;
  const idx = w.fx.list.features.findIndex((f) => f.id === bad);
  expect(staleCount(await w.round())).toBe(0);
  w.fail((id) => id === bad);
  const at: { t: number; stale: boolean }[] = [];
  while (w.t < 90_000) {
    w.advance();
    const m = await w.round();
    at.push({ t: w.t, stale: m[idx]!.mirror === "stale" });
  }
  // 落后在 65 秒内不算；超过 65 秒（列表前进、详情还是旧的）算过期
  for (const r of at) expect(r.stale).toBe(r.t > DETAIL_REFRESH_MS + POLL_MS);
  w.fail(null);
  // 429 推迟（Retry-After 1 秒）过后的下一轮读回成功：恢复
  w.advance();
  const m = await w.round();
  expect(m[idx]!.mirror).toBe("fresh");
  // 429 本轮停发会连带别的 feature 也没拉到（N8A8 退避，不改）：它们按每轮上限补完后也恢复
  let rounds = 0;
  for (let n = staleCount(m); n > 0; rounds++) { w.advance(); n = staleCount(await w.round()); }
  expect(rounds).toBeLessThanOrEqual(Math.ceil(26 / 8));
});

test("N8A8B-2b 读失败的 feature 换了列表位置、落到每轮上限之外：仍按超过 65 秒判过期，直到读回成功", async () => {
  const w = world();
  const bad = w.fx.list.features[3]!.id;
  expect(staleCount(await w.round())).toBe(0);
  w.fail((id) => id === bad);
  const at: { t: number; stale: boolean }[] = [];
  while (w.t < 90_000) {
    // 第 65 秒起列表顺序反转：bad 排到到期队列第 8 个之后，本轮没轮到它
    if (w.t === DETAIL_REFRESH_MS) w.reverse();
    w.advance();
    at.push({ t: w.t, stale: (await w.byId()).get(bad)!.mirror === "stale" });
  }
  // 60 秒已读失败过：排没排上队都不豁免，落后超过 65 秒就算过期
  for (const r of at) expect(r).toEqual({ t: r.t, stale: r.t > DETAIL_REFRESH_MS + POLL_MS });
  w.fail(null);
  w.advance();
  expect((await w.byId()).get(bad)!.mirror).toBe("fresh");
});

test("N8A8B-3 详情 observedAt 超过 10 分钟（主场真停了，列表也不再前进）：计为过期，与 N8F 口径一致", async () => {
  const w = world();
  expect(staleCount(await w.round())).toBe(0);
  w.idle(MIRROR_FRESH_MS);
  expect(staleCount(await w.round())).toBe(0); // 正好 10 分钟还算新鲜
  w.idle(POLL_MS);
  const m = await w.round();
  expect(staleCount(m)).toBe(26);
  expect(m.every((x) => x.freshUntil === null && x.observedAt !== null)).toBe(true);
});

test("N8A8B 适配层边界：落后正好 65 秒不算、多 1 毫秒算；没读到详情按列表判；排队中不按落后判；列表没投影不算落后", () => {
  const fx = generateTeamFixture({ features: 1 });
  const d = fx.details[0]!, p = { sourceInstanceId: "home", sourceSeq: 1, observedAt: fx.now, receivedAt: fx.now };
  const shown: FeatureDetail = { ...d, feature: { ...d.feature, projection: p } };
  const listAt = (ms: number) => ({ ...d.feature, projection: { ...p, sourceSeq: 99, observedAt: fx.now + ms } });
  const lim = DETAIL_REFRESH_MS + POLL_MS;
  expect(mirrorFact(listAt(lim), shown, fx.now + lim)).toEqual({ mirror: "fresh", freshUntil: fx.now + MIRROR_FRESH_MS, observedAt: fx.now });
  expect(mirrorFact(listAt(lim + 1), shown, fx.now + lim + 1)).toEqual({ mirror: "stale", freshUntil: null, observedAt: fx.now });
  expect(mirrorFact(listAt(lim + 1), undefined, fx.now + lim + 1).mirror).toBe("fresh");
  // 还在每轮上限的队列里排队（没发过请求、不是读失败）：不按落后判；详情自己超过 10 分钟仍算过期
  expect(mirrorFact(listAt(lim + 1), shown, fx.now + lim + 1, true).mirror).toBe("fresh");
  expect(mirrorFact(listAt(MIRROR_FRESH_MS + 1), shown, fx.now + MIRROR_FRESH_MS + 1, true).mirror).toBe("stale");
  expect(mirrorFact({ ...d.feature, projection: null }, shown, fx.now).mirror).toBe("fresh");
});

test("CI r3：team-source-shared 先于 adapter 加载（两模块互相导入）也不撞 TDZ", () => {
  // 同进程里模块已被缓存，加载顺序测不出来；起一个干净子进程只先导入 shared。
  const script = [
    'const m = await import("./web/features/collab/team-source-shared.ts");',
    'if (typeof m.DETAIL_BEHIND_MS !== "number") process.exit(2);',
  ].join(" ");
  const r = Bun.spawnSync([process.execPath, "-e", script], { cwd: `${import.meta.dir}/..`, stderr: "pipe" });
  expect(r.stderr.toString()).not.toContain("before initialization");
  expect(r.exitCode).toBe(0);
});
