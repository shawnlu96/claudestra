/**
 * 订阅额度调度的后台节奏（lib/quota-scheduler.ts）：Claude 后台读取开关（owner 09-28 批准，bridge 缺省开）只按 6 小时读 Keychain，
 * 凭据坏着 / 睡眠唤醒都不多读；总开关关掉就不读；状态没变不写盘。
 */

import { describe, expect, test } from "bun:test";
import { memoryQuotaStore } from "../src/lib/quota-state.js";
import { T0, keychainBlob, okRoutes } from "./quota-fixtures.js";
import { HOUR, MIN, harness, type Harness } from "./quota-scheduler-harness.js";

describe("Claude 后台读取开关（owner 09-28 批准，bridge 缺省开）", () => {
  test("开：没人看时 Claude 也按 6 小时查；关回去立刻停，策略闸照旧", async () => {
    const h = harness();
    const claudeCalls = () => h.fetch.calls.filter((c) => c.url.includes("/oauth/usage")).length;
    await h.scheduler.tick({ viewing: false });
    expect(claudeCalls()).toBe(0);
    h.claudeBg = true;
    h.advance(5 * MIN);
    await h.scheduler.tick({ viewing: false });
    expect(claudeCalls()).toBe(1);
    h.advance(5 * MIN);
    await h.scheduler.tick({ viewing: false });
    expect(claudeCalls()).toBe(1);
    for (let i = 0; i < 72; i++) {
      h.advance(5 * MIN);
      await h.scheduler.tick({ viewing: false });
    }
    expect(claudeCalls()).toBe(2); // 6 小时后第二次
    h.claudeBg = false;
    for (let i = 0; i < 80; i++) {
      h.advance(5 * MIN);
      await h.scheduler.tick({ viewing: false });
    }
    expect(claudeCalls()).toBe(2);
    expect((await h.scheduler.refresh("claude", "background")).status).toBe("skipped_policy");
  });

  test("凭据坏着（token 过期 / 没有条目）或每小时睡眠唤醒：12 小时后台读 Keychain 不超过 2 次；打开看板不受这个节奏限制", async () => {
    const run = async (setup: (h: Harness) => void, stepMs: number) => {
      const h = harness();
      h.claudeBg = true;
      setup(h);
      for (let t = 0; t < 12 * HOUR; t += stepMs) {
        await h.scheduler.tick({ viewing: false });
        h.advance(stepMs);
      }
      return h;
    };
    const expired = await run((h) => (h.cd.keychain = { status: "ok", stdout: keychainBlob({ expiresAt: T0 - 1000 }) }), 5 * MIN);
    expect(expired.cd.keychainCalls.length).toBeLessThanOrEqual(2);
    const missing = await run((h) => (h.cd.keychain = { status: "missing" }), 5 * MIN);
    expect(missing.cd.keychainCalls.length).toBeLessThanOrEqual(2);
    const waking = await run(() => {}, HOUR); // 每个 tick 间隔 1 小时 > 15 分钟 = 每次都是睡眠唤醒
    expect(waking.cd.keychainCalls.length).toBeLessThanOrEqual(2);
    expect(waking.fetch.calls.filter((c) => c.url.includes("/oauth/usage")).length).toBeLessThanOrEqual(2);
    // 打开看板是 view 触发，不走后台节奏：刚在后台读过也照样读（60 秒最小间隔之外）
    waking.advance(2 * MIN);
    const before = waking.cd.keychainCalls.length;
    expect((await waking.scheduler.refresh("claude", "view")).status).toBe("fetched");
    expect(waking.cd.keychainCalls.length).toBe(before + 1);
  });

  test("看板设置里的总开关关掉：后台开关开着也不读 Keychain、不发请求", async () => {
    const h = harness();
    h.claudeBg = true;
    h.enabled = false;
    for (let i = 0; i < 80; i++) {
      h.advance(5 * MIN);
      await h.scheduler.tick({ viewing: false });
    }
    expect(h.cd.keychainCalls).toHaveLength(0);
    expect(h.fetch.calls).toHaveLength(0);
    h.enabled = true; // 打开后下一个后台 tick 就读
    h.advance(5 * MIN);
    await h.scheduler.tick({ viewing: false });
    expect(h.fetch.calls.filter((c) => c.url.includes("/oauth/usage"))).toHaveLength(1);
  });
});


describe("写盘", () => {
  test("内容没变就不写 quota-state.json：没人看的 tick 与提醒账本的空读改写都不落盘", async () => {
    const store = memoryQuotaStore();
    const h = harness(okRoutes, store);
    await h.scheduler.refresh("codex", "view");
    h.advance(MIN + 1000);
    await h.scheduler.refreshResetCredits("view");
    const after = store.saved;
    for (let i = 0; i < 10; i++) {
      h.advance(5 * MIN);
      await h.scheduler.tick({ viewing: false });
      await h.scheduler.withReminders((l) => l);
    }
    expect(store.saved).toBe(after);
    h.advance(7 * HOUR); // 到了后台节奏：真查了一次，内容变了才写
    await h.scheduler.tick({ viewing: false });
    expect(store.saved).toBeGreaterThan(after);
  });
});


describe("凭据失败的节奏（对抗式审查 P2）", () => {
  const bg12h = async (setup: (h: Harness) => void, stepMs = 5 * MIN) => {
    const h = harness();
    h.claudeBg = true;
    setup(h);
    for (let t = 0; t < 12 * HOUR; t += stepMs) {
      await h.scheduler.tick({ viewing: false });
      h.advance(stepMs);
    }
    return h;
  };

  test("后台遇到 Keychain 超时 / 出错：不永久停，按 6 小时节奏重试（12 小时 ≤ 2 次）", async () => {
    for (const status of ["timeout", "error"] as const) {
      const h = await bg12h((x) => (x.cd.keychain = { status }));
      expect(h.cd.keychainCalls.length).toBe(2);
    }
  });

  test("Keychain 连续被拒 2 次：后台也停，等用户重试；用户重试解除", async () => {
    const h = harness();
    h.claudeBg = true;
    h.cd.keychain = { status: "denied" };
    for (let t = 0; t < 24 * HOUR; t += 5 * MIN) {
      await h.scheduler.tick({ viewing: false });
      h.advance(5 * MIN);
    }
    expect(h.cd.keychainCalls.length).toBe(2);
    h.cd.keychain = { status: "ok", stdout: keychainBlob() + "\n" };
    expect((await h.scheduler.refresh("claude", "user_retry")).status).toBe("fetched");
  });

  test("凭据失败时用户重试也守 60 秒；读完 Keychain 才出错的（条目认不出）看板开着至少 5 分钟才再读", async () => {
    const h = harness();
    h.cd.keychain = { status: "ok", stdout: "not-json\n" };
    expect((await h.scheduler.refresh("claude", "user_retry")).status).toBe("failed");
    h.advance(20_000);
    expect((await h.scheduler.refresh("claude", "user_retry")).status).toBe("skipped_interval");
    expect(h.cd.keychainCalls).toHaveLength(1);
    for (let i = 0; i < 4; i++) {
      h.advance(MIN);
      await h.scheduler.tick({ viewing: true });
    }
    expect(h.cd.keychainCalls).toHaveLength(1); // 4 分 20 秒内看板一直开着也不再读
    h.advance(MIN);
    await h.scheduler.tick({ viewing: true });
    expect(h.cd.keychainCalls).toHaveLength(2);
  });

  test("时钟前跳一年又拨回：上次尝试记在未来就按现在重置，48 小时内后台照常读", async () => {
    const h = harness();
    h.claudeBg = true;
    h.advance(365 * 24 * HOUR);
    await h.scheduler.tick({ viewing: false });
    const afterJump = h.cd.keychainCalls.length;
    expect(afterJump).toBe(1);
    h.advance(-365 * 24 * HOUR);
    for (let t = 0; t < 48 * HOUR; t += 5 * MIN) {
      await h.scheduler.tick({ viewing: false });
      h.advance(5 * MIN);
    }
    const back = h.cd.keychainCalls.length - afterJump;
    expect(back).toBeGreaterThanOrEqual(7);
    expect(back).toBeLessThanOrEqual(8);
    // 回拨后 Codex 明细也不停（记录在未来按到期算）
    expect(h.fetch.calls.filter((c) => c.url.includes("rate-limit-reset-credits")).length).toBeGreaterThan(2);
  });
});

describe("Claude 客户端身份头（不带就看不到重置卡）", () => {
  test("探到本机版本 → Claude 请求带 claude-cli/<版本> 的 UA；探不到 / 探测抛错 → 不带，请求照常；Codex 从不带", async () => {
    const h = harness();
    h.ccVersion = "2.1.283";
    await h.scheduler.refresh("claude", "view");
    await h.scheduler.refresh("codex", "view");
    const ua = (i: number) => h.fetch.calls[i].headers["User-Agent"];
    expect(ua(0)).toBe("claude-cli/2.1.283 (external, cli)");
    expect(ua(1)).toBeUndefined();
    h.advance(MIN + 1000);
    h.ccVersion = "throw";
    expect((await h.scheduler.refresh("claude", "view")).status).toBe("fetched");
    expect(ua(2)).toBeUndefined();
  });
});
