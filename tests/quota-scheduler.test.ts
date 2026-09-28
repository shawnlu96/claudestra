/**
 * 订阅额度调度（lib/quota-scheduler.ts + lib/quota-state.ts）：单一在途请求、60 秒间隔、失败分类与冷却、
 * 开关与身份复核丢弃、账户隔离、重启后状态仍在。全部假 fetch / 时钟 / 凭据 / 存储。
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmCredential, hmacHex, peekAccountKey, readClaudeCredential, readCodexCredential } from "../src/lib/quota-credentials.js";
import { planExpiryReminder } from "../src/lib/quota-reminder-rules.js";
import { applyFailure, backoffMs, QUOTA_TIMING, QuotaScheduler } from "../src/lib/quota-scheduler.js";
import { emptyQuotaState, fileQuotaStore, memoryQuotaStore, normalizeQuotaState, pruneAccounts, type QuotaStore } from "../src/lib/quota-state.js";
import {
  SECRET,
  T0,
  codexAuth,
  expectNoSentinel,
  fakeCredDeps,
  fakeFetch,
  jsonResponse,
  keychainBlob,
  okRoutes,
  resetCreditsBody,
} from "./quota-fixtures.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

type Route = (url: string, signal: AbortSignal) => Response | Promise<Response>;
interface Harness {
  now: number;
  enabled: boolean;
  cd: ReturnType<typeof fakeCredDeps>;
  fetch: ReturnType<typeof fakeFetch>;
  route: Route;
  store: QuotaStore;
  scheduler: QuotaScheduler;
  advance(ms: number): void;
  fresh(): QuotaScheduler;
}

function harness(route: Route = okRoutes, store: QuotaStore = memoryQuotaStore()): Harness {
  const h: Harness = {
    now: T0,
    enabled: true,
    cd: fakeCredDeps(),
    fetch: fakeFetch((u, s) => h.route(u, s)),
    route,
    store,
    scheduler: null as unknown as QuotaScheduler,
    advance(ms: number) {
      h.now += ms;
    },
    fresh() {
      h.scheduler = new QuotaScheduler({
        now: () => h.now,
        random: () => 0.5,
        fetch: h.fetch,
        readCredential: (p) => (p === "claude" ? readClaudeCredential(h.cd) : readCodexCredential(h.cd)),
        confirmCredential: (c) => confirmCredential(c, h.cd),
        peekAccountKey: (p) => peekAccountKey(p, h.cd),
        hashCreditId: (acct, id) => hmacHex(SECRET, acct, id),
        store: h.store,
        isEnabled: () => h.enabled,
      });
      return h.scheduler;
    },
  };
  h.fresh();
  return h;
}

const urlsOf = (h: Harness) => h.fetch.calls.map((c) => c.url.split("/").pop());

describe("合并与限频", () => {
  test("网页 / Discord / 后台同时刷新同一家 → 只发一个请求", async () => {
    const h = harness();
    const rs = await Promise.all([h.scheduler.refresh("codex", "view"), h.scheduler.refresh("codex", "manual"), h.scheduler.refresh("codex", "wake")]);
    expect(rs.map((r) => r.status)).toEqual(["fetched", "fetched", "fetched"]);
    expect(h.fetch.calls).toHaveLength(1);
  });

  test("同一家的两个端点串行，而且共用 60 秒间隔（设计稿：同一家）", async () => {
    let active = 0;
    let peak = 0;
    const h = harness(async (u, s) => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active--;
      return okRoutes(u);
    });
    const rs = await Promise.all([h.scheduler.refresh("codex", "view"), h.scheduler.refreshResetCredits("view")]);
    expect(rs.map((r) => r.status)).toEqual(["fetched", "skipped_interval"]);
    expect(peak).toBe(1);
    expect(h.fetch.calls).toHaveLength(1);
    h.advance(61_000);
    expect((await h.scheduler.refreshResetCredits("view")).status).toBe("fetched");
  });

  test("60 秒内再刷新（含手动）→ skipped_interval，而且不去读 Keychain", async () => {
    const h = harness();
    expect((await h.scheduler.refresh("claude", "view")).status).toBe("fetched");
    h.advance(30_000);
    expect((await h.scheduler.refresh("claude", "manual")).status).toBe("skipped_interval");
    expect(h.cd.keychainCalls).toHaveLength(1);
    h.advance(31_000);
    expect((await h.scheduler.refresh("claude", "manual")).status).toBe("fetched");
  });

  test("Claude 从不在后台读 Keychain", async () => {
    const h = harness();
    expect((await h.scheduler.refresh("claude", "background")).status).toBe("skipped_policy");
    expect(h.cd.keychainCalls).toHaveLength(0);
    expect(h.fetch.calls).toHaveLength(0);
  });
});

describe("失败分类与冷却", () => {
  test("401：同一份凭据 30 分钟内不再发；凭据指纹变了，下一次核对（看板节奏）或用户重试立刻可发", async () => {
    const h = harness(() => jsonResponse(401, {}));
    expect(await h.scheduler.refresh("claude", "view")).toEqual({ status: "failed", code: "http_401" });
    h.advance(2 * MIN);
    expect(await h.scheduler.refresh("claude", "manual")).toEqual({ status: "skipped_cooldown", code: "http_401" });
    expect(h.cd.keychainCalls).toHaveLength(1); // 核对节奏未到，不读 Keychain
    h.advance(4 * MIN);
    expect(await h.scheduler.refresh("claude", "view")).toEqual({ status: "skipped_cooldown", code: "http_401" });
    expect(h.cd.keychainCalls).toHaveLength(2); // 到节奏了读一次，指纹没变照样挡
    expect(h.fetch.calls).toHaveLength(1);
    h.cd.keychain = { status: "ok", stdout: keychainBlob({ accessToken: "renewed-by-cc" }) };
    h.route = okRoutes;
    expect((await h.scheduler.refresh("claude", "user_retry")).status).toBe("fetched");
  });

  test("401 冷却期间看板一直开着：30 分钟最多读 6 次 Keychain、只发 1 次请求", async () => {
    const h = harness(() => jsonResponse(401, {}));
    for (let i = 0; i < 30; i++) {
      await h.scheduler.tick({ viewing: true });
      h.advance(MIN);
    }
    expect(h.cd.keychainCalls.length).toBeLessThanOrEqual(6);
    expect(h.fetch.calls.filter((c) => c.url.endsWith("/oauth/usage"))).toHaveLength(1);
  });

  test("401 后 CC 续期了 token：下一次核对就恢复，不用等满 30 分钟", async () => {
    const h = harness(() => jsonResponse(401, {}));
    await h.scheduler.refresh("claude", "view");
    h.cd.keychain = { status: "ok", stdout: keychainBlob({ accessToken: "renewed-by-cc" }) };
    h.route = okRoutes;
    h.advance(5 * MIN);
    expect((await h.scheduler.refresh("claude", "view")).status).toBe("fetched");
  });

  test("401 冷却到期后同一份凭据也可以再试", async () => {
    const h = harness(() => jsonResponse(401, {}));
    await h.scheduler.refresh("codex", "view");
    h.advance(QUOTA_TIMING.authCooldownMs + 1);
    h.route = okRoutes;
    expect((await h.scheduler.refresh("codex", "view")).status).toBe("fetched");
  });

  test("403 长冷却", async () => {
    const h = harness(() => jsonResponse(403, {}));
    await h.scheduler.refresh("codex", "view");
    h.advance(HOUR);
    expect(await h.scheduler.refresh("codex", "view")).toEqual({ status: "skipped_cooldown", code: "http_403" });
    h.advance(QUOTA_TIMING.forbiddenCooldownMs);
    h.route = okRoutes;
    expect((await h.scheduler.refresh("codex", "view")).status).toBe("fetched");
  });

  test("429 是账户级：Retry-After 期间同账户另一个端点也等", async () => {
    const h = harness(() => jsonResponse(429, {}, { "retry-after": "600" }));
    await h.scheduler.refresh("codex", "view");
    expect(await h.scheduler.refreshResetCredits("view")).toEqual({ status: "skipped_cooldown", code: "http_429" });
    h.advance(10 * MIN + 1);
    h.route = okRoutes;
    expect((await h.scheduler.refreshResetCredits("view")).status).toBe("fetched");
  });

  test("5xx / 网络：指数退避加抖动", async () => {
    expect(backoffMs(1, 0)).toBe(48_000);
    expect(backoffMs(1, 1)).toBe(72_000);
    expect(backoffMs(3, 0.5)).toBe(4 * MIN);
    expect(backoffMs(30, 0.5)).toBe(HOUR);
    const h = harness(() => jsonResponse(502, {}));
    await h.scheduler.refresh("codex", "view");
    h.advance(61_000);
    await h.scheduler.refresh("codex", "view"); // 第 1 次退避 60s 已过，第 2 次失败 → 退避 120s
    h.advance(61_000);
    expect(await h.scheduler.refresh("codex", "view")).toEqual({ status: "skipped_cooldown", code: "http_5xx" });
    h.advance(60_000);
    expect(await h.scheduler.refresh("codex", "view")).toEqual({ status: "failed", code: "http_5xx" });
  });

  test("404 / 形状不对 → 暂停端点，health() 报出来；用户主动重试可以解除", async () => {
    const h = harness(() => jsonResponse(404, {}));
    await h.scheduler.refresh("codex", "view");
    expect((await h.scheduler.health()).codex_usage).toEqual({ paused: true, lastCode: "http_404" });
    h.advance(2 * HOUR);
    expect((await h.scheduler.refresh("codex", "manual")).status).toBe("skipped_paused");
    h.route = okRoutes;
    expect((await h.scheduler.refresh("codex", "user_retry")).status).toBe("fetched");
    expect((await h.scheduler.health()).codex_usage).toEqual({ paused: false, lastCode: null });
  });

  test("Keychain 被拒 / 超时 → 只认用户主动重试，看板怎么开都不再读", async () => {
    for (const status of ["denied", "timeout"] as const) {
      const h = harness();
      h.cd.keychain = { status };
      expect((await h.scheduler.refresh("claude", "view")).status).toBe("failed");
      h.advance(24 * HOUR);
      expect((await h.scheduler.refresh("claude", "view")).status).toBe("skipped_cooldown");
      expect(h.cd.keychainCalls).toHaveLength(1);
      expect((await h.scheduler.view()).claude.credFailure).toEqual({ code: `keychain_${status}`, needsUserRetry: true });
      h.cd.keychain = { status: "ok", stdout: keychainBlob() };
      expect((await h.scheduler.refresh("claude", "user_retry")).status).toBe("fetched");
      expect((await h.scheduler.view()).claude.credFailure).toBeNull();
    }
  });

  test("applyFailure：401 让账户变「不确定」", () => {
    const acct = { provider: "codex" as const, identity: "bound" as const, uncertain: false, rateLimitedUntil: null, lastSeenAt: 0, snapshots: {}, health: {} };
    const h = { lastCode: null, lastAttemptAt: 0, failures: 0, cooldownUntil: null, authFingerprint: null, paused: false };
    applyFailure(acct, h, { code: "http_401" }, { now: 0, fingerprint: "fp", random: 0 });
    expect(acct.uncertain).toBe(true);
    expect(h).toMatchObject({ lastCode: "http_401", cooldownUntil: QUOTA_TIMING.authCooldownMs, authFingerprint: "fp" });
  });
});

describe("丢弃：开关与身份复核", () => {
  test("开关关着：不读凭据、不发请求", async () => {
    const h = harness();
    h.enabled = false;
    expect((await h.scheduler.refresh("codex", "view")).status).toBe("disabled");
    await h.scheduler.tick({ viewing: true });
    expect(h.fetch.calls).toHaveLength(0);
    expect(h.cd.reads).toHaveLength(0);
  });

  test("在途时关开关 → 结果回来也不入库", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(async (u) => {
      await gate;
      return okRoutes(u);
    });
    const p = h.scheduler.refresh("codex", "view");
    await Bun.sleep(5);
    h.enabled = false;
    h.scheduler.onDisabled();
    release();
    expect((await p).status).toBe("discarded");
    h.enabled = true;
    const v = await h.scheduler.view();
    expect(v.codex.endpoints.codex_usage?.snapshot ?? null).toBeNull();
    expect(JSON.stringify((h.store as ReturnType<typeof memoryQuotaStore>).peek() ?? {})).not.toContain("codex_usage\":{\"data");
  });

  test("请求期间换号 → 丢弃，不把旧号的数据记到任何账户下", async () => {
    const h = harness((u) => {
      h.cd.files.set("/home/u/.codex/auth.json", codexAuth("tok2", "someone-else"));
      return okRoutes(u);
    });
    expect((await h.scheduler.refresh("codex", "view")).status).toBe("discarded");
    const st = (h.store as ReturnType<typeof memoryQuotaStore>).peek();
    for (const a of Object.values(st?.accounts ?? {})) expect(a.snapshots.codex_usage).toBeUndefined();
  });
});

describe("账户隔离与持久化", () => {
  test("换号后看不到旧号的快照；换回来旧号的冷却还在", async () => {
    const h = harness(() => jsonResponse(403, {}));
    await h.scheduler.refresh("codex", "view"); // A：403 长冷却
    h.cd.files.set("/home/u/.codex/auth.json", codexAuth("tokB", "account-B"));
    h.route = okRoutes;
    h.advance(2 * MIN);
    expect((await h.scheduler.refresh("codex", "view")).status).toBe("fetched"); // B 不受 A 的冷却影响
    const vb = await h.scheduler.view();
    expect(vb.codex.account?.key).toBe(hmacHex(SECRET, "codex", "account-B"));
    h.cd.files.set("/home/u/.codex/auth.json", codexAuth());
    h.advance(2 * MIN);
    expect(await h.scheduler.refresh("codex", "view")).toEqual({ status: "skipped_cooldown", code: "http_403" });
    const va = await h.scheduler.view();
    expect(va.codex.account?.key).toBe(hmacHex(SECRET, "codex", "raw-codex-account-id-0001"));
    expect(va.codex.endpoints.codex_usage?.snapshot).toBeNull(); // A 从没成功过，不拿 B 的数据充数
  });

  test("Claude 换号后 Keychain 被拒：卡片归新号（无数据），不继续展示旧号", async () => {
    const h = harness();
    await h.scheduler.refresh("claude", "view");
    h.cd.files.set("/home/u/.claude.json", JSON.stringify({ oauthAccount: { accountUuid: "new-claude-account" } }));
    h.cd.keychain = { status: "denied" };
    h.advance(2 * MIN);
    await h.scheduler.refresh("claude", "view");
    const v = await h.scheduler.view();
    expect(v.claude.account?.key).toBe(hmacHex(SECRET, "claude", "new-claude-account"));
    expect(v.claude.endpoints.claude_usage?.snapshot).toBeNull();
  });

  test("凭据缺一方 → 当前账户清空（不再把旧卡片当成它）", async () => {
    const h = harness();
    await h.scheduler.refresh("codex", "view");
    h.cd.files.delete("/home/u/.codex/auth.json");
    h.advance(2 * MIN);
    expect(await h.scheduler.refresh("codex", "view")).toEqual({ status: "failed", code: "auth_missing" });
    const v = await h.scheduler.view();
    expect(v.codex.account).toBeNull();
    expect(v.codex.credFailure).toEqual({ code: "auth_missing", needsUserRetry: false });
  });

  test("重置明细失败不影响额度快照", async () => {
    const h = harness((u) => (u.endsWith("reset-credits") ? jsonResponse(500, {}) : okRoutes(u)));
    await h.scheduler.refresh("codex", "view");
    h.advance(61_000);
    await h.scheduler.refreshResetCredits("view");
    const v = await h.scheduler.view();
    expect(v.codex.endpoints.codex_usage).toMatchObject({ lastCode: null, stale: false });
    expect(v.codex.endpoints.codex_usage?.snapshot?.data.windows).toHaveLength(2);
    expect(v.codex.endpoints.codex_reset_credits).toMatchObject({ snapshot: null, lastCode: "http_5xx", stale: true });
  });

  test("重启（同一个 store 新建调度器）：冷却和快照都还在", async () => {
    const h = harness(() => jsonResponse(401, {}));
    await h.scheduler.refresh("codex", "view");
    h.fresh();
    h.advance(2 * MIN);
    expect(await h.scheduler.refresh("codex", "view")).toEqual({ status: "skipped_cooldown", code: "http_401" });
    h.route = okRoutes;
    await h.scheduler.refresh("claude", "view");
    h.fresh();
    expect((await h.scheduler.view()).claude.endpoints.claude_usage?.snapshot?.data.windows).toHaveLength(3);
  });

  test("重启后提醒去重仍有效", async () => {
    const body = resetCreditsBody();
    (body.credits as Record<string, unknown>[])[0].expires_at = new Date(T0 + 48 * HOUR).toISOString();
    const h = harness((u) => (u.endsWith("reset-credits") ? jsonResponse(200, body) : okRoutes(u)));
    await h.scheduler.refreshResetCredits("background");
    const plan = async () => {
      let notice = null as unknown;
      await h.scheduler.withReminders((ledger, view) => {
        const ep = view.codex.endpoints.codex_reset_credits!;
        const ctx = { accountKey: view.codex.account!.key, now: h.now, stale: ep.stale, uncertain: view.codex.account!.uncertain };
        const r = planExpiryReminder(ledger, ep.snapshot!.data.credits, ctx);
        notice = r.notice;
        return r.ledger;
      });
      return notice;
    };
    expect(await plan()).not.toBeNull();
    h.fresh();
    expect(await plan()).toBeNull();
  });

  test("状态里没有 token、原始账户 id、credit 原始 id、email", async () => {
    const h = harness();
    await h.scheduler.refresh("claude", "view");
    await h.scheduler.refresh("codex", "view");
    h.advance(61_000);
    expect((await h.scheduler.refreshResetCredits("view")).status).toBe("fetched");
    expectNoSentinel(JSON.stringify((h.store as ReturnType<typeof memoryQuotaStore>).peek()));
    expectNoSentinel(JSON.stringify(await h.scheduler.view()));
  });

  test("文件存储：0600、读回一致、坏文件按空重来", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quota-state-"));
    const path = join(dir, "quota-state.json");
    const store = fileQuotaStore(path);
    expect(await store.load()).toEqual(emptyQuotaState());
    const s = { ...emptyQuotaState(), current: { codex: "k" } };
    await store.save(s);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await store.load()).toEqual(s);
    writeFileSync(path, "{broken");
    expect(await store.load()).toEqual(emptyQuotaState());
  });

  test("30 天没见的非当前账户被清掉", () => {
    const acct = (lastSeenAt: number) => ({ provider: "codex" as const, identity: "bound" as const, uncertain: false, rateLimitedUntil: null, lastSeenAt, snapshots: {}, health: {} });
    const s = { ...emptyQuotaState(), current: { codex: "cur" }, accounts: { cur: acct(0), old: acct(0), recent: acct(T0 - HOUR) } };
    expect(Object.keys(pruneAccounts(s, T0).accounts).sort()).toEqual(["cur", "recent"]);
  });
});

describe("tick 节奏", () => {
  test("有人看：两家额度；明细等过了同家 60 秒再查；5 分钟后只查额度", async () => {
    const h = harness();
    await h.scheduler.tick({ viewing: true });
    expect(urlsOf(h)).toEqual(["usage", "usage"]);
    h.advance(MIN);
    await h.scheduler.tick({ viewing: true });
    expect(urlsOf(h)).toEqual(["usage", "usage", "rate-limit-reset-credits"]);
    h.advance(MIN);
    await h.scheduler.tick({ viewing: true });
    expect(h.fetch.calls).toHaveLength(3);
    h.advance(5 * MIN);
    await h.scheduler.tick({ viewing: true });
    expect(urlsOf(h).slice(3)).toEqual(["usage", "usage"]);
  });

  test("没人看：只查 Codex 重置明细，6 小时一次；Claude 从不查", async () => {
    const h = harness();
    await h.scheduler.tick({ viewing: false });
    for (let i = 0; i < 35; i++) {
      h.advance(10 * MIN);
      await h.scheduler.tick({ viewing: false });
    }
    expect(urlsOf(h)).toEqual(["rate-limit-reset-credits"]);
    h.advance(10 * MIN);
    await h.scheduler.tick({ viewing: false });
    expect(urlsOf(h)).toEqual(["rate-limit-reset-credits", "rate-limit-reset-credits"]);
    expect(h.cd.keychainCalls).toHaveLength(0);
  });

  test.each([5, 10, 16])("有人看、定时器每 %i 分钟一次：12 小时里重置明细不被额度查询饿死", async (every) => {
    const h = harness();
    for (let t = 0; t < 12 * 60; t += every) {
      await h.scheduler.tick({ viewing: true });
      h.advance(every * MIN);
    }
    const urls = urlsOf(h);
    expect(urls.filter((u) => u === "rate-limit-reset-credits").length).toBeGreaterThanOrEqual(10);
    expect(urls.filter((u) => u === "usage").length).toBeGreaterThanOrEqual(12 * 60 / Math.max(every, 5) / 2);
  });

  test("tick 自己兜底：内部出错不向定时器抛", async () => {
    const store: QuotaStore = { load: async () => { throw new Error("EIO"); }, save: async () => {} };
    const h = harness(okRoutes, store);
    await h.scheduler.tick({ viewing: true });
    await h.scheduler.tick({ viewing: false });
  });

  test("睡眠唤醒（两次 tick 间隔远超节奏）→ 立刻重查", async () => {
    const h = harness();
    await h.scheduler.tick({ viewing: false });
    h.advance(20 * MIN);
    await h.scheduler.tick({ viewing: false });
    expect(urlsOf(h)).toEqual(["rate-limit-reset-credits", "rate-limit-reset-credits"]);
  });
});

describe("出错不冒泡、写盘串行、重试不白按", () => {
  test("读凭据抛异常（如 spawn EMFILE）→ failed internal，挂 5 分钟冷却", async () => {
    const h = harness();
    const s = new QuotaScheduler({
      now: () => h.now, random: () => 0.5, fetch: h.fetch,
      readCredential: async () => { throw Object.assign(new Error("spawn EMFILE"), { code: "EMFILE" }); },
      peekAccountKey: (p) => peekAccountKey(p, h.cd),
      confirmCredential: (c) => confirmCredential(c, h.cd),
      hashCreditId: (a, id) => hmacHex(SECRET, a, id), store: h.store, isEnabled: () => true,
    });
    expect(await s.refresh("codex", "view")).toEqual({ status: "failed", code: "internal" });
    h.advance(2 * MIN);
    expect(await s.refresh("codex", "view")).toEqual({ status: "skipped_cooldown", code: "internal" });
    expect((await s.view()).codex.credFailure).toEqual({ code: "internal", needsUserRetry: false });
  });

  test("存储读取失败一次：不永久失明，下一次重读", async () => {
    let fail = true;
    const inner = memoryQuotaStore();
    const store: QuotaStore = { load: async () => { if (fail) { fail = false; throw new Error("EIO"); } return inner.load(); }, save: inner.save };
    const h = harness(okRoutes, store);
    expect(await h.scheduler.refresh("codex", "view")).toEqual({ status: "failed", code: "internal" });
    h.advance(6 * MIN);
    expect((await h.scheduler.refresh("codex", "view")).status).toBe("fetched");
  });

  test("两家并发写盘：保存排成一条，最后落盘的是完整状态", async () => {
    const inner = memoryQuotaStore();
    let n = 0;
    const store: QuotaStore = {
      load: inner.load,
      save: async (st) => {
        const snap = structuredClone(st);
        await Bun.sleep(n++ === 0 ? 30 : 0); // 第一次写得慢：不串行的话它会后落盘、盖掉第二次
        await inner.save(snap);
      },
    };
    const h = harness(okRoutes, store);
    await Promise.all([h.scheduler.refresh("claude", "view"), h.scheduler.refresh("codex", "view")]);
    await Bun.sleep(50);
    const accts = Object.values(inner.peek()!.accounts);
    expect(accts.some((a) => a.snapshots.claude_usage)).toBe(true);
    expect(accts.some((a) => a.snapshots.codex_usage)).toBe(true);
  });

  test("用户重试并进一个被挡掉的普通查询 → 再单独跑一次", async () => {
    const h = harness(() => jsonResponse(404, {}));
    await h.scheduler.refresh("codex", "view");
    h.advance(2 * MIN);
    h.route = okRoutes;
    const [plain, retry] = await Promise.all([h.scheduler.refresh("codex", "view"), h.scheduler.refresh("codex", "user_retry")]);
    expect(plain.status).toBe("skipped_paused");
    expect(retry.status).toBe("fetched");
  });
});

describe("状态文件里的原型链键", () => {
  test("current / 账户键是 __proto__、constructor：读回时丢掉，view() 与 tick() 不抛", async () => {
    const raw = JSON.parse(
      '{"v":1,"current":{"codex":"__proto__","claude":"constructor"},"credHealth":{},' +
        '"accounts":{"__proto__":{"provider":"codex","identity":"bound","uncertain":false,"rateLimitedUntil":null,"lastSeenAt":1,"snapshots":{},"health":{}},' +
        '"constructor":{"provider":"claude","identity":"assumed","uncertain":false,"rateLimitedUntil":null,"lastSeenAt":1,"snapshots":{},"health":{}}},' +
        '"reminders":{"credits":{},"exhausted":{},"outbox":[]}}',
    );
    const h = harness(okRoutes, { load: async () => structuredClone(raw), save: async () => {} } as QuotaStore);
    const s = new QuotaScheduler({
      now: () => h.now, random: () => 0.5, fetch: h.fetch,
      readCredential: (p) => (p === "claude" ? readClaudeCredential(h.cd) : readCodexCredential(h.cd)),
      peekAccountKey: (p) => peekAccountKey(p, h.cd), confirmCredential: (c) => confirmCredential(c, h.cd),
      hashCreditId: (a, id) => hmacHex(SECRET, a, id), isEnabled: () => true,
      store: { load: async () => normalizeQuotaState(structuredClone(raw)), save: async () => {} },
    });
    const v = await s.view();
    expect(v.codex.account).toBeNull();
    expect(v.claude.account).toBeNull();
    await s.tick({ viewing: true });
    expect((await s.view()).codex.account).not.toBeNull();
  });
});
