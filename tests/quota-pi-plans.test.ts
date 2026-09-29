/**
 * Pi 接入商的套餐用量 / 余额（lib/quota-pi-plans.ts）：认哪家、key 只发往它自己的主机、三家的解析、5 分钟节奏与退避、
 * 和本机本周用量合成一张卡（lib/quota-pi.ts mergePiEntries）。全部假 fetch。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseDeepSeekBalance, parseKimi, parseOpenCodeGo, piPlanEntries, planKindOf, readPlanProviders, resetPlanCache, type PlanProvider,
} from "../src/lib/quota-pi-plans.js";
import { mergePiEntries } from "../src/lib/quota-pi.js";
import type { ProviderEntry } from "../src/lib/quota-layers.js";
import type { QuotaFetch } from "../src/lib/quota-providers.js";

beforeEach(() => resetPlanCache());

const RESET = "2026-09-30T06:00:00Z";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("认哪家、读 models.json", () => {
  test("只认 https、主机逐字相等；认不出的不查", () => {
    expect(planKindOf("https://api.deepseek.com/v1")).toBe("deepseek_balance");
    expect(planKindOf("https://opencode.ai/zen/go/v1")).toBe("opencode_go");
    expect(planKindOf("https://api.kimi.com/coding/v1")).toBe("kimi_coding");
    for (const u of ["http://api.deepseek.com/v1", "https://api.deepseek.com.evil.io/v1", "https://opencode.ai/zen/v1", "https://api.moonshot.cn/v1", "not a url", undefined]) {
      expect(planKindOf(u)).toBeNull();
    }
  });

  test("models.json：认得的、有 key 的才列；`!命令` 形式不执行；环境变量名取环境值；文件不在 = 空", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-plans-"));
    process.env.PI_PLAN_TEST_KEY = "sk-from-env";
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: {
      ds: { baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-literal" },
      go: { baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "PI_PLAN_TEST_KEY" },
      kimi: { baseUrl: "https://api.kimi.com/coding/v1", apiKey: "!security find-generic-password -w" },
      other: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-x" },
      nokey: { baseUrl: "https://api.deepseek.com/v1" },
    } }));
    expect(readPlanProviders(dir)).toEqual([
      { name: "ds", kind: "deepseek_balance", apiKey: "sk-literal" },
      { name: "go", kind: "opencode_go", apiKey: "sk-from-env" },
    ]);
    expect(readPlanProviders(join(dir, "missing"))).toEqual([]);
  });
});

describe("三家的解析", () => {
  test("OpenCode Go：rolling / weekly / monthly → 5 小时 / 本周 / 本月；percent 为 0 时不显示重置时刻", () => {
    const m = parseOpenCodeGo({ usage: { rolling: { percent: 42, resetsAt: RESET, status: "ok" }, weekly: { percent: 0, resetsAt: RESET }, monthly: { percent: "7.5" } } });
    expect(m!.map((x) => [x.id, x.kind, x.label, x.used, x.resetsAtMs])).toEqual([
      ["session", "session", null, 42, Date.parse(RESET)],
      ["weekly", "weekly", null, 0, null],
      ["monthly", "other", "本月", 7.5, null],
    ]);
    expect(parseOpenCodeGo({ usage: {} })).toBeNull();
    expect(parseOpenCodeGo({ something: "else" })).toBeNull();
  });

  test("Kimi：limit / remaining 折成已用百分比；重置时刻认 ISO、Unix 秒、毫秒", () => {
    const secs = Date.parse(RESET) / 1000;
    const m = parseKimi({ limits: [{ detail: { limit: 200, remaining: 150, resetTime: secs } }], usage: { limit: "1000", remaining: "100", resetTime: Date.parse(RESET) } });
    expect(m!.map((x) => [x.id, x.used, x.resetsAtMs])).toEqual([["session", 25, Date.parse(RESET)], ["weekly", 90, Date.parse(RESET)]]);
    expect(parseKimi({ limits: [{ detail: { limit: 0, remaining: 0 } }] })).toBeNull();
  });

  test("DeepSeek：余额按两位小数，数字串也认；币种不合规不带", () => {
    expect(parseDeepSeekBalance({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "12.3" }] })).toEqual({ amount: "12.30", currency: "CNY" });
    expect(parseDeepSeekBalance({ balance_infos: [{ currency: "<b>", total_balance: 5 }] })).toEqual({ amount: "5.00", currency: null });
    expect(parseDeepSeekBalance({ balance_infos: [] })).toBeNull();
  });
});

describe("查询节奏与安全", () => {
  const go: PlanProvider = { name: "go", kind: "opencode_go", apiKey: "sk-go-secret" };
  const ds: PlanProvider = { name: "ds", kind: "deepseek_balance", apiKey: "sk-ds-secret" };

  function rig(responses: Record<string, () => Response>) {
    let now = 1_000_000;
    const calls: { url: string; auth: string }[] = [];
    const fetch: QuotaFetch = async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization! });
      return responses[url]!();
    };
    const run = (ps: PlanProvider[]) => piPlanEntries({ fetch, now: () => now, providers: () => ps });
    return { calls, run, advance: (ms: number) => (now += ms) };
  }

  test("key 只发往自己那家的固定地址；5 分钟内不重查；同时来的两次只打一次接口", async () => {
    const r = rig({
      "https://opencode.ai/zen/go/v1/usage": () => json({ usage: { weekly: { percent: 30, resetsAt: RESET } } }),
      "https://api.deepseek.com/user/balance": () => json({ balance_infos: [{ currency: "CNY", total_balance: "8" }] }),
    });
    const [a, b] = await Promise.all([r.run([go, ds]), r.run([go, ds])]);
    expect(r.calls).toEqual([
      { url: "https://opencode.ai/zen/go/v1/usage", auth: "Bearer sk-go-secret" },
      { url: "https://api.deepseek.com/user/balance", auth: "Bearer sk-ds-secret" },
    ]);
    expect(a).toEqual(b);
    expect(a.map((e) => [e.id, e.kind, e.plan, e.source.layer, e.balance ?? null])).toEqual([
      ["pi:go", "subscription", "OpenCode Go", "live", null],
      ["pi:ds", "api", "DeepSeek", "live", { amount: "8.00", currency: "CNY" }],
    ]);
    expect(JSON.stringify(a)).not.toContain("secret");
    r.advance(4 * 60_000);
    await r.run([go, ds]);
    expect(r.calls.length).toBe(2);
    r.advance(2 * 60_000);
    await r.run([go, ds]);
    expect(r.calls.length).toBe(4);
  });

  test("403（key 有效但没开套餐）：1 小时后再查、原因给 Pi 专用码；之前成功过的数据留着标「实时过期」；换了 key 立刻重查", async () => {
    let status = 200;
    const r = rig({ "https://opencode.ai/zen/go/v1/usage": () => (status === 200 ? json({ usage: { weekly: { percent: 30 } } }) : json({ error: "x" }, status)) });
    await r.run([go]);
    status = 403;
    r.advance(6 * 60_000);
    const [e] = await r.run([go]);
    expect([e!.source.layer, e!.source.reason, e!.meters.length]).toEqual(["live_stale", "pi_no_plan", 1]);
    r.advance(30 * 60_000);
    await r.run([go]);
    expect(r.calls.length).toBe(2);
    await r.run([{ ...go, apiKey: "sk-new" }]);
    expect(r.calls.length).toBe(3);
  });

  test("从没成功过：layer none、带错误码；返回格式不认得 = bad_shape", async () => {
    const r = rig({ "https://opencode.ai/zen/go/v1/usage": () => json({ totally: "different" }) });
    const [e] = await r.run([go]);
    expect([e!.source.layer, e!.source.reason, e!.meters]).toEqual(["none", "bad_shape", []]);
  });
});

describe("和本机本周用量合成一张卡", () => {
  const local = (name: string): ProviderEntry => ({
    id: `pi:${name}`, name, kind: "api", account: { key: null, identity: "unknown" },
    meters: [{ id: "week_tokens", kind: "usage", label: null, unit: "tokens", used: 100 }],
    source: { layer: "local_cache", observedAt: 1, reason: null },
  });
  test("同一个接入商只出一张（本周 tokens 接在套餐量条后面）；只有本机用量的照旧单独一张", () => {
    const plan: ProviderEntry = {
      ...local("go"), kind: "subscription",
      meters: [{ id: "weekly", kind: "weekly", label: null, unit: "pct", used: 30 }], source: { layer: "live", observedAt: 2, reason: null },
    };
    const out = mergePiEntries([plan], [local("go"), local("other")]);
    expect(out.map((e) => [e.id, e.meters.map((m) => m.id), e.source.layer])).toEqual([
      ["pi:go", ["weekly", "week_tokens"], "live"],
      ["pi:other", ["week_tokens"], "local_cache"],
    ]);
  });
});
