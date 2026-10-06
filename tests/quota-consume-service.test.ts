/**
 * 使用 Codex 重置卡 × 真实 createQuotaService + QuotaScheduler（审查 #687 复核）：请求过了服务入口之后再手改配置关掉开关，
 * 出队复验和 POST 紧前复验都要现读配置（服务的 syncEnabled），不能用入口时缓存的 enabled。
 * 「配置文件」是可变的 cfgEnabled（服务的 readEnabled 每次现读它）；GET / POST 全是假的，真实接口一次都不调。
 */

import { expect, test } from "bun:test";
import { createQuotaService } from "../src/bridge/quota-service.js";
import { confirmCredential, hmacHex, peekAccountKey, readClaudeCredential, readCodexCredential } from "../src/lib/quota-credentials.js";
import { QuotaScheduler } from "../src/lib/quota-scheduler.js";
import { memoryQuotaStore } from "../src/lib/quota-state.js";
import { SECRET, T0, fakeCredDeps, fakeFetch, fakePost, jsonResponse, usableRoutes } from "./quota-fixtures.js";

function setup() {
  const cfg = { enabled: true }; // 手改 config.json：不经过服务的任何方法
  const holds = new Map<string, Promise<void>>();
  let posted = false;
  const fetch = fakeFetch(async (url) => {
    const hold = [...holds].find(([suffix]) => url.endsWith(suffix));
    if (hold) {
      holds.delete(hold[0]);
      await hold[1];
    }
    return usableRoutes(() => (posted ? 0 : 1))(url);
  });
  const post = fakePost(() => {
    posted = true;
    return jsonResponse(200, { code: "reset", windows_reset: 2 });
  });
  const cd = fakeCredDeps();
  const svc = createQuotaService({
    now: () => T0,
    makeScheduler: (isEnabled, enabledNow) => new QuotaScheduler({
      now: () => T0, random: () => 0.5, fetch,
      readCredential: (p) => (p === "claude" ? readClaudeCredential(cd) : readCodexCredential(cd)),
      peekAccountKey: (p) => peekAccountKey(p, cd),
      confirmCredential: (c) => confirmCredential(c, cd),
      hashCreditId: (a, id) => hmacHex(SECRET, a, id),
      store: memoryQuotaStore(),
      isEnabled,
      enabledNow,
      consumeFetch: post,
    }),
    readEnabled: () => cfg.enabled,
    writeEnabled: async (v) => void (cfg.enabled = v),
    local: async () => ({ claudeCache: null, codexRollout: null, extra: [] }),
    afterTick: async () => {},
    setTimer: () => 0,
    clearTimer: () => {},
    log: () => {},
  });
  /** 让下一个以 suffix 结尾的 GET 挂住，返回放行函数与「已经挂住了吗」 */
  const hold = (suffix: string) => {
    let release: () => void = () => {};
    holds.set(suffix, new Promise<void>((r) => (release = r)));
    return { release, reached: () => !holds.has(suffix) };
  };
  return { cfg, svc, post, hold };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 500 && !cond(); i++) await Bun.sleep(1);
  expect(cond()).toBe(true);
};

test("排队中手改配置关开关：前面挂着一个普通查询，出队现读配置 → refused disabled，POST 0", async () => {
  const { cfg, svc, post, hold } = setup();
  const g = hold("/wham/usage");
  const pending = svc.retry("codex"); // 普通查询占住 Codex 串行链
  await until(g.reached);
  const consume = svc.consumeCodexReset(null); // 过了入口（此刻开关还开着），排在后面
  cfg.enabled = false; // 只改配置文件，不调服务
  g.release();
  expect(await consume).toEqual({ status: "refused", code: "disabled" });
  await pending;
  expect(post.calls).toHaveLength(0);
  expect(svc.isEnabled()).toBe(false); // 复验时服务也同步到了配置里的值
});

test("POST 紧前手改配置关开关：核对用的明细 GET 挂着时关 → refused disabled，POST 0", async () => {
  const { cfg, svc, post, hold } = setup();
  const g = hold("/wham/rate-limit-reset-credits");
  const consume = svc.consumeCodexReset(null);
  await until(g.reached);
  cfg.enabled = false;
  g.release();
  expect(await consume).toEqual({ status: "refused", code: "disabled" });
  expect(post.calls).toHaveLength(0);
});

test("对照：配置一直开着 → 照常用掉一张，POST 1", async () => {
  const { svc, post } = setup();
  expect(await svc.consumeCodexReset(null)).toEqual({ status: "done", code: "reset", windowsReset: 2 });
  expect(post.calls).toHaveLength(1);
});
