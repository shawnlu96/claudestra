/**
 * bridge/quota-service.ts：定时器节奏（有人看 60 秒、看板关了降到 5 分钟）、打开看板时先查一次、开关（关时在途结果不入库、
 * 提醒不跑）、快照里没有凭据与原始 id。真实 QuotaScheduler + 内存存储 + 假 fetch / 凭据 / 定时器。
 */

import { describe, expect, test } from "bun:test";
import { createQuotaService, QUOTA_CADENCE, type QuotaServiceDeps } from "../src/bridge/quota-service.js";
import { confirmCredential, hmacHex, peekAccountKey, readClaudeCredential, readCodexCredential } from "../src/lib/quota-credentials.js";
import type { ProviderEntry } from "../src/lib/quota-layers.js";
import { QuotaScheduler } from "../src/lib/quota-scheduler.js";
import { memoryQuotaStore } from "../src/lib/quota-state.js";
import { SECRET, T0, expectNoSentinel, fakeCredDeps, fakeFetch, okRoutes } from "./quota-fixtures.js";

const MIN = 60_000;

function harness(opts: { enabled?: boolean; route?: (url: string) => Response | Promise<Response>; extra?: ProviderEntry[] } = {}) {
  const h = {
    now: T0,
    timers: [] as { fn: () => void; ms: number; id: number; cleared: boolean }[],
    ticks: [] as boolean[],
    afterTicks: 0,
    persisted: [] as boolean[],
    store: memoryQuotaStore(),
    scheduler: null as unknown as QuotaScheduler,
  };
  const cd = fakeCredDeps();
  const fetch = fakeFetch((url) => (opts.route ?? okRoutes)(url));
  let nextId = 1;
  const deps: QuotaServiceDeps = {
    now: () => h.now,
    makeScheduler: (isEnabled) => {
      h.scheduler = new QuotaScheduler({
        now: () => h.now, random: () => 0.5, fetch,
        readCredential: (p) => (p === "claude" ? readClaudeCredential(cd) : readCodexCredential(cd)),
        peekAccountKey: (p) => peekAccountKey(p, cd),
        confirmCredential: (c) => confirmCredential(c, cd),
        hashCreditId: (a, id) => hmacHex(SECRET, a, id),
        store: h.store,
        isEnabled,
      });
      const tick = h.scheduler.tick.bind(h.scheduler);
      h.scheduler.tick = (o) => {
        h.ticks.push(o.viewing);
        return tick(o);
      };
      return h.scheduler;
    },
    readEnabled: () => opts.enabled ?? true,
    writeEnabled: async (v) => void h.persisted.push(v),
    local: async () => ({ claudeCache: null, codexRollout: null, extra: opts.extra ?? [] }),
    afterTick: async () => void h.afterTicks++,
    setTimer: (fn, ms) => {
      const t = { fn, ms, id: nextId++, cleared: false };
      h.timers.push(t);
      return t.id;
    },
    clearTimer: (id) => {
      const t = h.timers.find((x) => x.id === id);
      if (t) t.cleared = true;
    },
    log: () => {},
  };
  const svc = createQuotaService(deps);
  /** 当前挂着的那个定时器 */
  const live = () => h.timers.filter((t) => !t.cleared && t.ms !== QUOTA_CADENCE.openWaitMs);
  /** 让当前定时器到点：推时钟、跑 tick、等它把下一个挂上 */
  async function fire() {
    const [t] = live();
    t.cleared = true;
    h.now += t.ms;
    t.fn();
    for (let i = 0; i < 20 && !live().length; i++) await Bun.sleep(1);
  }
  return { h, svc, fetch, live, fire };
}

describe("定时器节奏", () => {
  test("没人看 5 分钟一次；打开看板切到 60 秒；关掉看板（90 秒没拉）降回 5 分钟", async () => {
    const t = harness();
    t.svc.start();
    expect(t.live().map((x) => x.ms)).toEqual([QUOTA_CADENCE.idleTickMs]);
    await t.fire();
    expect(t.h.ticks).toEqual([false]);

    await t.svc.snapshot(); // 打开看板
    expect(t.live().map((x) => x.ms)).toEqual([QUOTA_CADENCE.viewingTickMs]);
    await t.fire();
    expect(t.h.ticks.at(-1)).toBe(true);
    expect(t.live()[0].ms).toBe(QUOTA_CADENCE.viewingTickMs); // 60 秒前才拉过：还算有人看

    await t.fire(); // 又过 60 秒没人拉：距上次 GET 120 秒 > 90 秒
    expect(t.h.ticks.at(-1)).toBe(false);
    expect(t.live()[0].ms).toBe(QUOTA_CADENCE.idleTickMs);
    t.svc.stop();
    expect(t.live()).toHaveLength(0);
  });

  test("打开看板时两家各查一次；90 秒内再拉不重复触发（调度器 60 秒间隔之外，这里也不白等）", async () => {
    const t = harness();
    t.svc.start();
    const v = await t.svc.snapshot();
    expect(t.fetch.calls.map((c) => c.url.split("/").pop()).sort()).toEqual(["usage", "usage"]);
    expect(v.snapshot.providers.map((p) => `${p.id}:${p.source.layer}`)).toEqual(["claude:live", "codex:live"]);
    t.h.now += 30_000;
    await t.svc.snapshot();
    expect(t.fetch.calls).toHaveLength(2);
    expectNoSentinel(JSON.stringify(v));
  });

  test("首查卡住：最多等 openWaitMs 就先回快照（不把看板拖死）", async () => {
    const t = harness({ route: () => new Promise<Response>(() => {}) });
    t.svc.start();
    const p = t.svc.snapshot();
    for (let i = 0; i < 20 && !t.h.timers.some((x) => x.ms === QUOTA_CADENCE.openWaitMs); i++) await Bun.sleep(1);
    t.h.timers.find((x) => x.ms === QUOTA_CADENCE.openWaitMs)!.fn();
    const v = await p;
    expect(v.snapshot.providers.every((e) => e.source.layer !== "live")).toBe(true);
  });

  test("Pi 接入商条目原样拼在两家后面", async () => {
    const pi: ProviderEntry = { id: "pi:acme", name: "acme", kind: "api", account: { key: null, identity: "unknown" }, meters: [], source: { layer: "local_cache", observedAt: T0, reason: null } };
    const t = harness({ extra: [pi] });
    const v = await t.svc.snapshot();
    expect(v.snapshot.providers.at(-1)?.id).toBe("pi:acme");
  });
});

describe("开关", () => {
  test("关：先落盘，在途请求回来也不入库；之后 tick 不发请求、不跑提醒", async () => {
    let release: (r: Response) => void = () => {};
    const t = harness({ route: (url) => (url.endsWith("/wham/usage") ? new Promise<Response>((r) => (release = r)) : okRoutes(url)) });
    t.svc.start();
    const inflight = t.svc.retry("codex");
    for (let i = 0; i < 20 && t.fetch.calls.length === 0; i++) await Bun.sleep(1);
    await t.svc.setEnabled(false);
    release(okRoutes("https://chatgpt.com/backend-api/wham/usage"));
    expect((await inflight).status).toBe("discarded");
    expect(t.h.persisted).toEqual([false]);
    const st = await t.h.store.load();
    expect(Object.values(st?.accounts ?? {}).every((a) => !a.snapshots.codex_usage)).toBe(true);

    const calls = t.fetch.calls.length;
    await t.fire();
    expect(t.fetch.calls.length).toBe(calls);
    expect(t.h.afterTicks).toBe(0);
    const v = await t.svc.snapshot();
    expect(v.enabled).toBe(false);
    expect(v.snapshot.providers.filter((p) => p.id === "claude" || p.id === "codex")).toHaveLength(0);
    expect(await t.svc.retry("claude")).toEqual({ status: "disabled" });
  });

  test("开着时每个 tick 后跑提醒；配置里是关的就从关开始", async () => {
    const on = harness();
    on.svc.start();
    await on.fire();
    expect(on.h.afterTicks).toBe(1);
    const off = harness({ enabled: false });
    expect(off.svc.isEnabled()).toBe(false);
    await off.svc.snapshot();
    expect(off.fetch.calls).toHaveLength(0);
  });

  test("用户重试：Codex 额度正常、只有重置明细坏了 → 重试明细；否则重试额度", async () => {
    let detailDown = true;
    const t = harness({ route: (url) => (url.endsWith("/rate-limit-reset-credits") && detailDown ? new Response("<html>", { status: 404 }) : okRoutes(url)) });
    expect((await t.svc.retry("codex")).status).toBe("fetched");
    t.h.now += MIN + 1000;
    await t.h.scheduler.refreshResetCredits("view"); // 404 → 端点暂停
    expect((await t.svc.snapshot()).health.codex_reset_credits?.paused).toBe(true);
    detailDown = false;
    t.h.now += MIN + 1000;
    expect((await t.svc.retry("codex")).status).toBe("fetched");
    expect(t.fetch.calls.map((c) => c.url.split("/").pop())).toEqual(["usage", "rate-limit-reset-credits", "rate-limit-reset-credits"]);
    expect((await t.svc.snapshot()).health.codex_reset_credits?.paused).toBe(false);
  });
});
