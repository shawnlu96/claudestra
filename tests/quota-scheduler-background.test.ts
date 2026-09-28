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

