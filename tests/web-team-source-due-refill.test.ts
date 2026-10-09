/**
 * team-project-N8A8H：列表水位领先、但还没到重拉间隔的详情，到期时 follow 补拉一轮，不靠下一次台账变化。
 * 旧红新绿：main 上本机空闲、列表不再变时没有新一轮来拉，T+95 秒起持续判过期，窗口内详情请求为 0。
 * 用真 follow 循环（pollMs 1 毫秒），列表读取被闸住：测试每放行一次 = 注入时钟走 5 秒后的一次轮询；
 * follow 发事件时像 use-collab 一样重拉总览（这一路的列表读取不闸，全是微任务，在 follow 下一次 sleep 到点前读完）。
 */
import { expect, test } from "bun:test";
import { sharedCollabSource, DETAIL_BEHIND_MS, DETAIL_REFRESH_MS, DETAIL_REFRESH_PER_ROUND, POLL_MS } from "@/features/collab/team-source-shared";
import { mirrorAt } from "@/features/collab/collab-model";
import { generateTeamFixture } from "@/features/collab/shared/team-fixture-gen";
import { ApiError } from "@/lib/api/client";
import { SharedLedgerSession, type FeatureList, type Transport } from "@/lib/api/shared-ledger";

async function until(done: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!done() && Date.now() < deadline) await Bun.sleep(1);
  expect(done()).toBe(true);
}

function world() {
  const fx = generateTeamFixture({ features: 26 });
  const t0 = fx.now;
  let t = t0, seq = 1, fail: ((id: string) => boolean) | null = null;
  let list: FeatureList = fx.list;
  const base = new Map(fx.details.map((d) => [d.feature.id, d]));
  const tick = () => {
    seq++;
    list = { ...list, serverSeq: list.serverSeq + 1,
      features: fx.list.features.map((f) => ({ ...f, projection: { sourceInstanceId: "home", sourceSeq: seq, observedAt: t, receivedAt: t } })) };
  };
  tick();
  /** follow 的列表读取停在这里，等测试放行 */
  let gate: (() => void) | null = null, reloading = false;
  const reads: { id: string; t: number }[] = [];
  const transport: Transport = {
    list: async () => {
      if (!reloading) await new Promise<void>((resolve) => { gate = resolve; });
      return list;
    },
    detail: async (id) => {
      reads.push({ id, t: t - t0 });
      if (fail?.(id)) throw new ApiError("rate limited", 429, { error: "rate limited", retryAfter: 1 });
      const d = structuredClone(base.get(id)!);
      d.feature = { ...d.feature, projection: list.features.find((f) => f.id === id)!.projection };
      return d;
    },
    command: async () => { throw new Error("unused"); },
    receipt: async (id) => ({ status: "unknown", requestId: id }),
  };
  const identity = { center: "c", team: fx.team, person: "p", project: fx.project, machine: "m" };
  const src = sharedCollabSource(new SharedLedgerSession(identity, transport), "team", "label", 1, { now: () => t });
  let reload: Promise<unknown> = Promise.resolve();
  /** 不经闸读一轮总览（首轮 / follow 发事件时） */
  const overview = () => {
    reloading = true;
    const p = src.overview(new AbortController().signal);
    reloading = false;
    return p;
  };
  const ctl = new AbortController();
  let following: Promise<void> | null = null;
  return {
    fx, src, reads, ctl,
    get t() { return t - t0; },
    async start() {
      await overview();
      following = src.follow({ signal: ctl.signal, onOpen: () => {}, onEvent: () => { reload = overview(); } });
      await until(() => gate !== null);
    },
    /** 时钟走 5 秒（move = 本机来了新事件、列表水位全前进），放行 follow 的这一次轮询，等它处理完、停在下一次轮询 */
    async poll(move = false) {
      t += POLL_MS;
      if (move) tick();
      const release = gate!;
      gate = null;
      release();
      await until(() => gate !== null);
      await reload;
    },
    /** 按页面走表（注入时钟）读当前概览镜像 */
    mirrors: () => src.last()!.team.ov.mirror!.map((m) => mirrorAt(m, t)),
    fail: (f: ((id: string) => boolean) | null) => { fail = f; },
    async stop() { ctl.abort(); gate?.(); await following; },
  };
}
const stale = (m: readonly (string | null)[]) => m.filter((x) => x === "stale").length;

test("N8A8H-1 T 全部缓存 → T+30 列表水位全前进、own 不变 → 列表 5 分钟不动：到期补拉各一次，stale 恒 0，之后不再请求", async () => {
  const w = world();
  await w.start();
  expect(w.reads.length).toBe(26);
  const counts: { t: number; n: number }[] = [];
  try {
    while (w.t < 30_000) { await w.poll(); counts.push({ t: w.t, n: stale(w.mirrors()) }); }
    await w.poll(true);
    const moved = w.t;
    expect(moved).toBe(35_000);
    counts.push({ t: w.t, n: stale(w.mirrors()) });
    expect(w.reads.length).toBe(26); // 还没到 60 秒重拉间隔：用缓存
    while (w.t < moved + 5 * 60_000) { await w.poll(); counts.push({ t: w.t, n: stale(w.mirrors()) }); }
    expect(counts.filter((c) => c.n > 0)).toEqual([]);
    const refill = w.reads.slice(26);
    // 每个 feature 恰好补拉一次，都在缓存 60 秒到期之后，受每轮上限约束分几轮
    expect(refill.map((r) => r.id).sort()).toEqual(w.fx.list.features.map((f) => f.id).sort());
    expect(refill.every((r) => r.t >= DETAIL_REFRESH_MS)).toBe(true);
    const perRound = new Map<number, number>();
    for (const r of refill) perRound.set(r.t, (perRound.get(r.t) ?? 0) + 1);
    expect(Math.max(...perRound.values())).toBeLessThanOrEqual(DETAIL_REFRESH_PER_ROUND);
    // 补完之后列表与详情一致：不计落后
    expect(w.src.last()!.behindSince.size).toBe(0);
  } finally { await w.stop(); }
});

test("N8A8H-2 列表与详情一致、本机空闲 10 分钟：follow 照常轮询，详情请求为 0", async () => {
  const w = world();
  await w.start();
  const before = w.reads.length;
  try {
    while (w.t < 10 * 60_000) await w.poll();
    expect(w.reads.length).toBe(before);
    expect(w.src.last()!.behindSince.size).toBe(0);
  } finally { await w.stop(); }
});

test("N8A8H-3 到期补拉那一轮某 feature 持续 429 超过 65 秒：计为过期；读回成功后的下一轮恢复", async () => {
  const w = world();
  const idx = 3, bad = w.fx.list.features[idx]!.id;
  await w.start();
  w.fail((id) => id === bad);
  try {
    while (w.t < 30_000) await w.poll();
    await w.poll(true);
    const since = w.src.last()!.behindSince.get(bad)!;
    expect(since).toBe(w.fx.now + w.t);
    const at: { dt: number; stale: boolean }[] = [];
    while (w.fx.now + w.t - since < 100_000) {
      await w.poll();
      at.push({ dt: w.fx.now + w.t - since, stale: w.mirrors()[idx] === "stale" });
    }
    expect(w.reads.some((r) => r.id === bad && r.t >= DETAIL_REFRESH_MS)).toBe(true);
    for (const r of at) expect(r).toEqual({ dt: r.dt, stale: r.dt > DETAIL_BEHIND_MS });
    w.fail(null);
    await w.poll();
    expect(w.mirrors()[idx]).toBe("fresh");
    expect(w.src.last()!.behindSince.has(bad)).toBe(false);
  } finally { await w.stop(); }
});
