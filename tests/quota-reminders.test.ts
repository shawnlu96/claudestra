/**
 * bridge/quota-reminders.ts：Codex 重置次数提醒的投递——两档阈值各一次、去重跨重启、分渠道重试、夜间暂存与破例、
 * 用满提醒、文案里没有内部键 / 哨兵串。真实 QuotaScheduler + 内存存储 + 假 fetch / 凭据，时间都按本机时区构造。
 */

import { describe, expect, test } from "bun:test";
import { fmtLocal, inQuietHours, noticeBody, quietEndsAt, runReminders, urgentAtNight, type ReminderSenders } from "../src/bridge/quota-reminders.js";
import { confirmCredential, hmacHex, peekAccountKey, readClaudeCredential, readCodexCredential } from "../src/lib/quota-credentials.js";
import type { ReminderNotice } from "../src/lib/quota-reminder-rules.js";
import { QuotaScheduler } from "../src/lib/quota-scheduler.js";
import { memoryQuotaStore, type QuotaStore } from "../src/lib/quota-state.js";
import {
  CREDIT_IDS, SECRET, cedarEmberBlock, claudeUsageBody, codexUsageBody, expectNoSentinel, fakeCredDeps, fakeFetch, jsonResponse, okRoutes, resetCreditsBody,
} from "./quota-fixtures.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 本机时区的 2026-10-01 hh:mm */
const local = (h: number, m = 0) => new Date(2026, 9, 1, h, m).getTime();

function creditsExpiring(...expires: number[]) {
  const body = resetCreditsBody() as { credits: Record<string, unknown>[] };
  body.credits = expires.map((e, i) => ({ ...body.credits[i % 2], id: CREDIT_IDS[i % 2] + i, expires_at: new Date(e).toISOString() }));
  return { ...body, available_count: expires.length };
}

function harness(opts: { now: number; credits: unknown; usage?: unknown; claude?: unknown; store?: QuotaStore }) {
  const h = {
    now: opts.now,
    credits: opts.credits,
    usage: opts.usage ?? codexUsageBody(),
    store: opts.store ?? memoryQuotaStore(),
    sent: [] as { channel: "push" | "discord"; title?: string; body: string }[],
    pushResult: { sent: 1, failed: 0 } as { sent: number; failed: number } | null,
    discordOk: true,
    scheduler: null as unknown as QuotaScheduler,
  };
  const cd = fakeCredDeps();
  const fetch = fakeFetch((url) => {
    if (url.endsWith("/wham/rate-limit-reset-credits")) return jsonResponse(200, h.credits);
    if (url.endsWith("/wham/usage")) return jsonResponse(200, h.usage);
    if (url.includes("/api/oauth/usage") && opts.claude) return jsonResponse(200, opts.claude);
    return okRoutes(url);
  });
  const fresh = () =>
    (h.scheduler = new QuotaScheduler({
      now: () => h.now, random: () => 0.5, fetch,
      readCredential: (p) => (p === "claude" ? readClaudeCredential(cd) : readCodexCredential(cd)),
      peekAccountKey: (p) => peekAccountKey(p, cd),
      confirmCredential: (c) => confirmCredential(c, cd),
      hashCreditId: (a, id) => hmacHex(SECRET, a, id),
      store: h.store,
      isEnabled: () => true,
    }));
  fresh();
  const senders: ReminderSenders = {
    push: async (title, body) => {
      h.sent.push({ channel: "push", title, body });
      return h.pushResult;
    },
    discord: async (text) => {
      h.sent.push({ channel: "discord", body: text });
      return h.discordOk;
    },
  };
  return {
    h,
    cd,
    fresh,
    /** 拉一遍 Codex 两个端点（同家 60 秒间隔：中间推 61 秒） */
    async fetchCodex() {
      await h.scheduler.refresh("codex", "view");
      h.now += 61_000;
      await h.scheduler.refreshResetCredits("view");
    },
    run: () => runReminders(h.scheduler, senders, h.now),
  };
}

describe("快过期提醒", () => {
  test("72 小时档推一次：推送 + Discord 各一条；再跑、重启后再跑都不重发", async () => {
    const t = harness({ now: local(12), credits: creditsExpiring(local(12) + 48 * HOUR) });
    await t.fetchCodex();
    await t.run();
    expect(t.h.sent.map((s) => s.channel).sort()).toEqual(["discord", "push"]);
    expect(t.h.sent[0].body).toContain(fmtLocal(local(12) + 48 * HOUR));
    await t.run();
    t.fresh(); // 重启：同一份存储，新调度器
    t.h.now += 10 * MIN;
    await t.fetchCodex();
    await t.run();
    expect(t.h.sent).toHaveLength(2);
  });

  test("进入 24 小时再推一次（只一次）", async () => {
    const t = harness({ now: local(12), credits: creditsExpiring(local(12) + 48 * HOUR) });
    await t.fetchCodex();
    await t.run();
    t.h.now = local(12) + 25 * HOUR; // 离到期 23 小时（次日 13:00，不在夜间）
    await t.fetchCodex();
    await t.run();
    await t.run();
    expect(t.h.sent).toHaveLength(4);
  });

  test("一个渠道失败只重试它：Discord 失败，5 分钟后只重发 Discord", async () => {
    const t = harness({ now: local(12), credits: creditsExpiring(local(12) + 48 * HOUR) });
    t.h.discordOk = false;
    await t.fetchCodex();
    await t.run();
    expect(t.h.sent.map((s) => s.channel).sort()).toEqual(["discord", "push"]);
    t.h.discordOk = true;
    t.h.now += 6 * MIN;
    await t.run();
    expect(t.h.sent.map((s) => s.channel)).toEqual(expect.arrayContaining(["discord"]));
    expect(t.h.sent.slice(2).map((s) => s.channel)).toEqual(["discord"]);
    t.h.now += 6 * MIN;
    await t.run();
    expect(t.h.sent).toHaveLength(3);
  });

  test("推送：一台设备都没有 = 送到；推送子系统没起来 / 全部失败 = 失败待重试", async () => {
    const none = harness({ now: local(12), credits: creditsExpiring(local(12) + 48 * HOUR) });
    none.h.pushResult = { sent: 0, failed: 0 };
    await none.fetchCodex();
    await none.run();
    none.h.now += 6 * MIN;
    await none.run();
    expect(none.h.sent.filter((s) => s.channel === "push")).toHaveLength(1);

    for (const bad of [null, { sent: 0, failed: 2 }]) {
      const t = harness({ now: local(12), credits: creditsExpiring(local(12) + 48 * HOUR) });
      t.h.pushResult = bad;
      await t.fetchCodex();
      await t.run();
      t.h.now += 6 * MIN;
      await t.run();
      expect(t.h.sent.filter((s) => s.channel === "push")).toHaveLength(2);
      expect(t.h.sent.filter((s) => s.channel === "discord")).toHaveLength(1);
    }
  });

  test("文案只有次数与到期时刻：没有 credit 原始 id、内部键、账户、哨兵串", async () => {
    const t = harness({ now: local(12), credits: creditsExpiring(local(12) + 30 * HOUR, local(12) + 40 * HOUR) });
    await t.fetchCodex();
    await t.run();
    const text = JSON.stringify(t.h.sent);
    expectNoSentinel(text);
    expect(t.h.sent[0].body).toContain("2");
    const state = JSON.stringify(await t.h.store.load());
    for (const key of Object.keys((await t.h.store.load())!.reminders.credits)) expect(text).not.toContain(key.slice(0, 16));
    expect(state).not.toContain(CREDIT_IDS[0]);
  });
});

describe("夜间不打扰（23:00–08:00 本机时区）", () => {
  test("夜里规划的提醒暂存，08:00 后同一渠道合并成一条发出", async () => {
    const t = harness({ now: local(2), credits: creditsExpiring(local(2) + 60 * HOUR) });
    await t.fetchCodex();
    await t.run();
    expect(t.h.sent).toHaveLength(0);
    t.h.now = local(8, 5);
    await t.run();
    expect(t.h.sent.map((s) => s.channel).sort()).toEqual(["discord", "push"]);
  });

  test("有 credit 在 08:00 前就过期：夜里也立即发", async () => {
    const t = harness({ now: local(2), credits: creditsExpiring(local(5)) });
    await t.fetchCodex();
    await t.run();
    expect(t.h.sent.map((s) => s.channel).sort()).toEqual(["discord", "push"]);
  });

  test("边界：23:00 起算夜间、08:00 结束；夜间结束时刻跨日", () => {
    expect(inQuietHours(local(22, 59))).toBe(false);
    expect(inQuietHours(local(23))).toBe(true);
    expect(inQuietHours(local(7, 59))).toBe(true);
    expect(inQuietHours(local(8))).toBe(false);
    expect(quietEndsAt(local(23, 30))).toBe(new Date(2026, 9, 2, 8, 0).getTime());
    expect(quietEndsAt(local(3))).toBe(local(8));
    expect(quietEndsAt(local(12))).toBe(local(12));
    const n = (exp: number) => ({ kind: "expiry", credits: [{ key: "k", expiresAtMs: exp, thresholdH: 24 }] }) as ReminderNotice;
    expect(urgentAtNight(n(local(7, 59)), local(3))).toBe(true);
    expect(urgentAtNight(n(local(9)), local(3))).toBe(false);
  });
});

describe("用满提醒", () => {
  const maxed = (applicable: number) => {
    const b = codexUsageBody() as { rate_limit: Record<string, unknown> };
    b.rate_limit = { ...b.rate_limit, primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_at: Math.floor(local(15) / 1000) } };
    return { ...b, rate_limit_reset_credits: { available_count: 2, applicable_available_count: applicable } };
  };

  test("窗口 100% 且此刻可兑换 > 0：提醒一次，同一窗口不再提醒", async () => {
    const t = harness({ now: local(12), credits: creditsExpiring(local(12) + 20 * 24 * HOUR), usage: maxed(1) });
    await t.fetchCodex();
    await t.run();
    expect(t.h.sent).toHaveLength(2);
    expect(t.h.sent[0].body).toContain("1");
    t.h.now += 6 * MIN;
    await t.h.scheduler.refresh("codex", "view");
    await t.run();
    expect(t.h.sent).toHaveLength(2);
  });

  test("可兑换 0（持有 2 但此刻不能用）：不提醒", async () => {
    const t = harness({ now: local(12), credits: creditsExpiring(local(12) + 20 * 24 * HOUR), usage: maxed(0) });
    await t.fetchCodex();
    await t.run();
    expect(t.h.sent).toHaveLength(0);
  });

  test("文案带窗口名", () => {
    const n = { kind: "exhausted", exhausted: { applicable: 2, windowId: "5h", resetsAtMs: null } } as unknown as ReminderNotice;
    expect(noticeBody(n)).toMatch(/5/);
  });
});

describe("Claude 重置卡（与 Codex 同一套规则与去重）", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const claudeWith = (endsAt: number) => ({ ...claudeUsageBody(), cedar_ember: cedarEmberBlock([{ endsAt: iso(endsAt) }]) });

  test("72 小时档：两家同时命中 → 每个渠道合并成一条，标题两家都写；重启后不重发", async () => {
    const t = harness({ now: local(12), credits: creditsExpiring(local(12) + 48 * HOUR), claude: claudeWith(local(12) + 50 * HOUR) });
    await t.h.scheduler.refresh("claude", "view");
    await t.fetchCodex();
    await t.run();
    expect(t.h.sent).toHaveLength(2);
    const push = t.h.sent.find((x) => x.channel === "push")!;
    expect(push.title).toContain("Claude");
    expect(push.title).toContain("Codex");
    expect(push.body).toContain("Claude 有 1 张重置卡");
    expect(push.body).toContain("周重置日不变");
    expect(push.body).toContain("Codex 有 1 次");
    expectNoSentinel(JSON.stringify(t.h.sent));
    t.fresh();
    t.h.now += 2 * MIN;
    await t.h.scheduler.refresh("claude", "view");
    await t.run();
    expect(t.h.sent).toHaveLength(2);
  });

  test("没有截止日的卡不会过期，不进快过期提醒", async () => {
    const block = cedarEmberBlock([{ endsAt: iso(local(12) + 10 * HOUR) }]);
    (block.grants as Record<string, unknown>[])[0].ends_at = null;
    const t = harness({ now: local(12), credits: creditsExpiring(local(12) + 20 * 24 * HOUR), claude: { ...claudeUsageBody(), cedar_ember: block } });
    await t.h.scheduler.refresh("claude", "view");
    await t.run();
    expect(t.h.sent).toHaveLength(0);
  });

  test("23:30 暂存，05:30 那次读取碰上 ~/.claude.json 读不到（account_missing）：不丢，08:00 照样发出", async () => {
    const start = new Date(2026, 9, 1, 23, 30).getTime();
    const t = harness({ now: start, credits: creditsExpiring(start + 20 * 24 * HOUR), claude: claudeWith(start + 60 * HOUR) });
    await t.h.scheduler.refresh("claude", "view");
    await t.run();
    expect(t.h.sent).toHaveLength(0);
    const acct = t.cd.files.get("/home/u/.claude.json")!;
    t.cd.files.delete("/home/u/.claude.json");
    t.h.now = start + 6 * HOUR; // 05:30
    expect((await t.h.scheduler.refresh("claude", "view")).status).toBe("failed");
    await t.run();
    expect((await t.h.store.load())!.reminders.outbox).toHaveLength(1);
    t.cd.files.set("/home/u/.claude.json", acct);
    t.h.now = start + 8.5 * HOUR + 5 * MIN; // 08:05
    await t.run();
    expect(t.h.sent.map((x) => x.channel).sort()).toEqual(["discord", "push"]);
    expect(t.h.sent[0].body).toContain("Claude 有 1 张重置卡");
  });

  test("账本里有一条不认识的 provider（未来版本回滚 / 手改）：读回时丢掉，不卡死其余提醒", async () => {
    const t = harness({ now: local(12), credits: creditsExpiring(local(12) + 48 * HOUR) });
    const st = await t.h.store.load();
    const channels = { push: { status: "pending", attempts: 0, lastAt: null }, discord: { status: "pending", attempts: 0, lastAt: null } };
    st!.reminders.outbox.push({ id: "g", kind: "expiry", provider: "gemini", accountKey: "k", createdAt: local(12), credits: [], channels } as never);
    await t.h.store.save(st!);
    t.fresh();
    await t.fetchCodex();
    await t.run();
    expect(t.h.sent.map((x) => x.channel).sort()).toEqual(["discord", "push"]);
  });

  test("没有 cedar_ember（旧账号）/ 卡没到 72 小时：不提醒", async () => {
    const none = harness({ now: local(12), credits: creditsExpiring(local(12) + 20 * 24 * HOUR), claude: claudeUsageBody() });
    await none.h.scheduler.refresh("claude", "view");
    await none.run();
    const far = harness({ now: local(12), credits: creditsExpiring(local(12) + 20 * 24 * HOUR), claude: claudeWith(local(12) + 10 * 24 * HOUR) });
    await far.h.scheduler.refresh("claude", "view");
    await far.run();
    expect([...none.h.sent, ...far.h.sent]).toHaveLength(0);
  });
});

describe("发出前复核（暂存 / 重试期间情况变了）", () => {
  const maxedAt = (resetsAt: number, used = 100) => {
    const b = codexUsageBody() as { rate_limit: Record<string, unknown> };
    b.rate_limit = { ...b.rate_limit, primary_window: { used_percent: used, limit_window_seconds: 18000, reset_at: Math.floor(resetsAt / 1000) } };
    return { ...b, rate_limit_reset_credits: { available_count: 1, applicable_available_count: 1 } };
  };

  test("夜里暂存的用满提醒：到 08:00 窗口已经重置 → 不发，账本里也清掉", async () => {
    const t = harness({ now: local(2), credits: creditsExpiring(local(2) + 20 * 24 * HOUR), usage: maxedAt(local(5)) });
    await t.fetchCodex();
    await t.run();
    expect(t.h.sent).toHaveLength(0);
    t.h.now = local(8, 5);
    t.h.usage = maxedAt(local(10), 3); // 05:00 重置过了，新窗口才用 3%
    await t.h.scheduler.refresh("codex", "view");
    await t.run();
    expect(t.h.sent).toHaveLength(0);
    expect((await t.h.store.load())!.reminders.outbox).toHaveLength(0);
  });

  test("Discord 失败待重试期间重置卡被用掉了 → 不再补发", async () => {
    const t = harness({ now: local(12), credits: creditsExpiring(local(12) + 48 * HOUR) });
    t.h.discordOk = false;
    await t.fetchCodex();
    await t.run();
    expect(t.h.sent).toHaveLength(2);
    const used = creditsExpiring(local(12) + 48 * HOUR) as { credits: Record<string, unknown>[] };
    used.credits[0] = { ...used.credits[0], status: "redeemed", redeemed_at: "2026-10-01T04:00:00Z" };
    t.h.credits = used;
    t.h.discordOk = true;
    t.h.now += 6 * MIN;
    await t.h.scheduler.refreshResetCredits("view");
    await t.run();
    expect(t.h.sent).toHaveLength(2);
  });

  test("只剩部分重置仍有效：文案只写还有效的那几条", async () => {
    const t = harness({ now: local(12), credits: creditsExpiring(local(12) + 30 * HOUR, local(12) + 40 * HOUR) });
    t.h.discordOk = false;
    await t.fetchCodex();
    await t.run();
    const partly = creditsExpiring(local(12) + 30 * HOUR, local(12) + 40 * HOUR) as { credits: Record<string, unknown>[] };
    partly.credits[0] = { ...partly.credits[0], status: "redeemed", redeemed_at: "2026-10-01T04:00:00Z" };
    t.h.credits = partly;
    t.h.discordOk = true;
    t.h.now += 6 * MIN;
    await t.h.scheduler.refreshResetCredits("view");
    await t.run();
    const retry = t.h.sent.at(-1)!;
    expect(retry.channel).toBe("discord");
    expect(retry.body).toContain("Codex 有 1 次");
    expect(retry.body).toContain(fmtLocal(local(12) + 40 * HOUR));
    expect(retry.body).not.toContain(fmtLocal(local(12) + 30 * HOUR));
  });

  test("破例立即发只对还没过期的卡：已过期的不算紧急", () => {
    const n = (exp: number) => ({ kind: "expiry", credits: [{ key: "k", expiresAtMs: exp, thresholdH: 24 }] }) as ReminderNotice;
    expect(urgentAtNight(n(local(1)), local(3))).toBe(false);
  });
});
