/**
 * team-project-N8A8：团队视图详情取数不撞中心限流。fake session + 可注入时钟，按 5 秒一轮模拟：
 * 限并发 2、只有执行镜像水位变时同一 feature 60 秒一次、打开的 feature 每轮优先、429 本轮停发并按 Retry-After 推迟、缓存照用。
 */
import { expect, test } from "bun:test";
import { sharedCollabSource, detailBackoffMs, DETAIL_CONCURRENCY, DETAIL_REFRESH_MS } from "@/features/collab/team-source-shared";
import { sharedProductBoard } from "@/features/collab/dag/shared-product-model";
import { generateTeamFixture } from "@/features/collab/shared/team-fixture-gen";
import { ApiError } from "@/lib/api/client";
import { SharedLedgerSession, type FeatureList, type Transport } from "@/lib/api/shared-ledger";

const ROUND_MS = 5_000;

/** 30 个 feature；每轮 sourceSeq / observedAt 全变（本机全局事件号），rev / version / counts 不变 */
function world(opts: { bucket?: boolean } = {}) {
  const fx = generateTeamFixture({ features: 30 });
  let t = 0, seq = 1, inflight = 0, maxInflight = 0, tokens = 20, refilledAt = 0;
  const reads: { id: string; t: number }[] = [], limited: number[] = [];
  const details = new Map(fx.details.map((d) => [d.feature.id, d]));
  let list: FeatureList = fx.list;
  const tick = () => {
    seq++;
    list = { ...list, serverSeq: list.serverSeq + 1, features: list.features.map((f) => ({ ...f,
      projection: { sourceInstanceId: "home", sourceSeq: seq, observedAt: t, receivedAt: t } })) };
  };
  tick();
  let reject: ((id: string) => boolean) | null = null;
  const transport: Transport = {
    list: async () => list,
    detail: async (id) => {
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      try {
        await Promise.resolve(); await Promise.resolve();
        if (reject?.(id)) throw new ApiError("rate limited", 429, { error: "rate limited", retryAfter: 1 });
        if (opts.bucket) {
          // 中心 nginx：令牌桶 2r/s、burst 20，超出回 429 + Retry-After 1
          tokens = Math.min(20, tokens + (t - refilledAt) / 500); refilledAt = t;
          if (tokens < 1) { limited.push(t); throw new ApiError("rate limited", 429, { error: "rate limited", retryAfter: 1 }); }
          tokens--;
        }
        reads.push({ id, t });
        return details.get(id)!;
      } finally { inflight--; }
    },
    command: async () => { throw new Error("unused"); },
    receipt: async (id) => ({ status: "unknown", requestId: id }),
  };
  const identity = { center: "c", team: fx.team, person: "p", project: fx.project, machine: "m" };
  const src = sharedCollabSource(new SharedLedgerSession(identity, transport), "team", "label", ROUND_MS, { now: () => t });
  const round = async () => { await src.overview(new AbortController().signal); };
  return { fx, src, reads, limited, round,
    get t() { return t; }, advance: () => { t += ROUND_MS; tick(); },
    maxInflight: () => maxInflight, setList: (f: (l: FeatureList) => FeatureList) => { list = f(list); },
    reject: (f: ((id: string) => boolean) | null) => { reject = f; } };
}

test("N8A8-1 30 个 feature、每轮水位全变、120 秒：详情总数 ≤ 首轮 30 + 每个 60 秒一次 + 打开的每轮 1 次，在途 ≤ 2", async () => {
  const w = world(), open = w.fx.list.features[0]!.id;
  w.src.focus(open);
  let rounds = 0;
  for (;;) {
    await w.round(); rounds++;
    if (w.t >= 120_000) break;
    w.advance();
  }
  expect(rounds).toBe(25);
  expect(w.reads.length).toBeLessThanOrEqual(30 + 30 * 2 + rounds);
  expect(w.maxInflight()).toBeLessThanOrEqual(DETAIL_CONCURRENCY);
  // 打开的那个每轮都拉；其他的两次拉取至少隔 60 秒
  expect(w.reads.filter((r) => r.id === open).length).toBe(rounds);
  const byId = Map.groupBy(w.reads.filter((r) => r.id !== open), (r) => r.id);
  expect(byId.size).toBe(29);
  for (const rs of byId.values()) for (let i = 1; i < rs.length; i++) expect(rs[i]!.t - rs[i - 1]!.t).toBeGreaterThanOrEqual(DETAIL_REFRESH_MS);
  // 120 秒内每个都至少按水位重拉过一次（数据不会一直停在首轮）
  for (const rs of byId.values()) expect(rs.length).toBeGreaterThanOrEqual(2);
});

test("N8A8-2 中心令牌桶 2r/s、burst 20：首轮之后 60 秒内 429 ≤ 1，最终都有详情，打开的 feature 5 秒内有详情", async () => {
  const w = world({ bucket: true });
  await w.round();
  expect(w.limited.length).toBeLessThanOrEqual(DETAIL_CONCURRENCY); // 首轮 burst 用完回 429：只有已在途的会撞，本轮剩下的不再发
  const missing = w.fx.list.features.find((f) => !w.src.last()!.details.has(f.id))!;
  expect(missing).toBeDefined();
  w.src.focus(missing.id); // 用户点进一个还没详情的 feature
  w.advance();
  await w.round();
  expect(w.t).toBe(ROUND_MS);
  expect(w.src.last()!.details.has(missing.id)).toBe(true);
  while (w.t < 120_000) { w.advance(); await w.round(); }
  expect(w.limited.filter((at) => at > 0 && at <= 60_000).length).toBeLessThanOrEqual(1);
  expect(w.src.last()!.details.size).toBe(30);
  expect(w.maxInflight()).toBeLessThanOrEqual(DETAIL_CONCURRENCY);
});

test("N8A8-3 某个 feature 的 counts 或 version 变了 → 下一轮立即重拉它，不等 60 秒", async () => {
  const w = world();
  await w.round();
  const [a, b] = w.fx.list.features;
  const before = w.reads.length;
  w.advance();
  w.setList((l) => ({ ...l, features: l.features.map((f) => f.id === a!.id ? { ...f, counts: { ...f.counts, completed: f.counts.completed + 1 } } : f) }));
  await w.round();
  expect(w.reads.slice(before).map((r) => r.id)).toEqual([a!.id]);
  w.advance();
  w.setList((l) => ({ ...l, features: l.features.map((f) => f.id === b!.id ? { ...f, version: f.version + 1 } : f) }));
  await w.round();
  expect(w.reads.slice(before + 1).map((r) => r.id)).toEqual([b!.id]);
});

test("N8A8-4 429 时已缓存的详情保留，activeUnknown 不因 429 由已知变回未知；退避期内不再发", async () => {
  const w = world();
  await w.round();
  const known = w.src.last()!;
  expect(known.details.size).toBe(30);
  const unknownOf = (got: NonNullable<typeof known>) => sharedProductBoard(got.list, got.team.ov.now, got.team.ov.tasks, got.details)
    .features.map((f) => [f.id, "activeUnknown" in f.counts]);
  const before = unknownOf(known);
  let attempts = 0;
  w.reject(() => (attempts++, true));
  w.advance();
  // 所有 feature 自身都变了：全部要重拉，第一个就 429
  w.setList((l) => ({ ...l, features: l.features.map((f) => ({ ...f, rev: f.rev + 1 })) }));
  await w.round();
  expect(attempts).toBeLessThanOrEqual(DETAIL_CONCURRENCY); // 已在途的最多各一个，本轮剩下的不再发
  const after = w.src.last()!;
  expect(after.details.size).toBe(30);
  for (const [id, d] of known.details) expect(after.details.get(id)).toBe(d);
  expect(unknownOf(after)).toEqual(before);
  // Retry-After 1 秒已过（下一轮 5 秒后）→ 恢复拉取
  w.reject(null);
  const reads = w.reads.length;
  w.advance();
  await w.round();
  expect(w.reads.length).toBeGreaterThan(reads);
});

test("N8A8 429 推迟时长：Retry-After 秒数；没有按 5 秒；上限 60 秒；其他错误不退避", () => {
  expect(detailBackoffMs(new ApiError("x", 429, { retryAfter: 1 }))).toBe(1_000);
  expect(detailBackoffMs(new ApiError("x", 429, { retryAfter: "3" }))).toBe(3_000);
  expect(detailBackoffMs(new ApiError("x", 429, {}))).toBe(5_000);
  expect(detailBackoffMs(new ApiError("x", 429, { retryAfter: 600 }))).toBe(60_000);
  expect(detailBackoffMs(new ApiError("x", 503, {}))).toBeNull();
  expect(detailBackoffMs(new Error("x"))).toBeNull();
});

/** 详情响应挂起到手动放行：看同一时刻真正在途多少个 */
function deferred() {
  const fx = generateTeamFixture({ features: 30 });
  const details = new Map(fx.details.map((d) => [d.feature.id, d]));
  const waiting: (() => void)[] = [];
  let inflight = 0, maxInflight = 0, total = 0, lists = 0;
  const transport: Transport = {
    list: async () => { lists++; return fx.list; },
    detail: (id) => new Promise((resolve) => {
      inflight++; total++; maxInflight = Math.max(maxInflight, inflight);
      waiting.push(() => { inflight--; resolve(details.get(id)!); });
    }),
    command: async () => { throw new Error("unused"); },
    receipt: async (id) => ({ status: "unknown", requestId: id }),
  };
  const identity = { center: "c", team: fx.team, person: "p", project: fx.project, machine: "m" };
  const src = sharedCollabSource(new SharedLedgerSession(identity, transport), "team", "label", ROUND_MS);
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const drain = async () => { for (let i = 0; i < 200; i++) { await flush(); const w = waiting.splice(0); if (!w.length && !inflight) return; for (const r of w) r(); } };
  return { fx, src, flush, drain, waiting, maxInflight: () => maxInflight, total: () => total, lists: () => lists, inflight: () => inflight };
}

test("N8A8 r1：总览 / 子 DAG / 产品板同时挂载 → 整个源详情在途 ≤ 2，30 个各拉一次（不按调用方翻倍）", async () => {
  const w = deferred();
  const ctl = new AbortController();
  const all = Promise.all([w.src.overview(ctl.signal), w.src.dag!.board("team"), w.src.product!("team")]);
  await w.flush();
  expect(w.inflight()).toBeLessThanOrEqual(DETAIL_CONCURRENCY);
  await w.drain();
  await all;
  expect(w.maxInflight()).toBeLessThanOrEqual(DETAIL_CONCURRENCY);
  expect(w.total()).toBe(30);
  expect(w.src.last()!.details.size).toBe(30);
});

test("N8A8 r1：总览被新一轮取代（AbortSignal）→ 旧调用方退出，新一轮排在在读那轮之后，不并发第二组详情", async () => {
  const w = deferred();
  const first = new AbortController();
  const p1 = w.src.overview(first.signal);
  await w.flush();
  first.abort();
  await expect(p1).rejects.toThrow();
  const p2 = w.src.overview(new AbortController().signal);
  const p3 = w.src.overview(new AbortController().signal); // 两个后来者合并成同一轮
  await w.flush();
  expect(w.inflight()).toBeLessThanOrEqual(DETAIL_CONCURRENCY);
  await w.drain();
  await Promise.all([p2, p3]);
  expect(w.maxInflight()).toBeLessThanOrEqual(DETAIL_CONCURRENCY);
  expect(w.lists()).toBe(2); // 在读那轮 + 紧随其后合并的一轮
  expect(w.total()).toBe(30); // 第二轮全部命中缓存
});

test("N8A8 r1：点进没详情的 feature → 立刻重拉一轮（不等台账变化），它排最前；已缓存的不触发", async () => {
  const w = world({ bucket: true });
  await w.round(); // 首轮 burst 用完回 429，留下没详情的
  const missing = w.fx.list.features.filter((f) => !w.src.last()!.details.has(f.id)).at(-1)!;
  let pokes = 0;
  const ctl = new AbortController();
  const following = w.src.follow({ signal: ctl.signal, onOpen: () => {}, onEvent: () => { pokes++; } });
  w.src.focus(w.fx.list.features[0]!.id); // 已有详情：不重拉
  expect(pokes).toBe(0);
  w.src.focus(missing.id);
  expect(pokes).toBe(1);
  w.advance(); // use-collab 收到事件重拉总览；Retry-After 1 秒已过
  const before = w.reads.length;
  await w.round();
  expect(w.reads[before]!.id).toBe(missing.id);
  expect(w.src.last()!.details.has(missing.id)).toBe(true);
  ctl.abort();
  await following;
});
