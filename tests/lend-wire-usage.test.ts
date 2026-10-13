/**
 * LENDUSAGE1 线格式（src/lib/lend-wire.ts usageOf）：ResultRequest / DeliverRequest 可选的 usage，带了就严格校验、不合格整条 invalid；
 * 不带时解析结果与改前一致。声明方式 LEND_PROTO 3→4：老 B 的 hello 应答解析（parseV2Response，本卡未改）收 proto 4 不报错。
 */
import { describe, expect, test } from "bun:test";
import { parseLendRequest, USAGE_TOKEN_MAX, USAGE_CALLS_MAX, type LendUsage } from "../src/lib/lend-wire.js";
import { helloAnswer, LEND_PROTO, parseV2Response } from "../src/lib/lend-wire-v2.js";

const H = "a".repeat(40);
const ORDER = "lend:T9:s1:r1:a0";
const RESULT = { v: 1, orderId: ORDER, gen: 1, verdict: { v: 1, orderId: ORDER, head: H, verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: "r.md" },
  report: "## 结论\n通过", session: { id: "sess-1", family: "codex" } };
const DELIVER = { v: 1, orderId: ORDER, gen: 1, branch: "lend/T9-b1a2", pr: 7, session: { id: "sess-1", family: "claude" },
  deliver: { v: 1, orderId: ORDER, head: "5".repeat(40), evidence: "report.md", summary: "实现了 x", selfCheck: "先红后绿" } };
const CLAUDE: LendUsage = { family: "claude", input: 10, output: 20, cacheRead: 300, cacheWrite: 40, reasoning: 0, calls: 3, firstAt: 1_000, lastAt: 2_000 };
const CODEX: LendUsage = { family: "codex", input: 5, output: 6, cacheRead: 7, cacheWrite: 0, reasoning: 8, calls: 1, firstAt: 1_500, lastAt: 1_500 };

const parse = (body: unknown) => parseLendRequest("result", body);
const bad = (usage: unknown) => [parse({ ...RESULT, usage }), parse({ ...DELIVER, usage })];

describe("[验收线 1] 带合法 usage 的请求能解析", () => {
  test("审查结论与写单交付都收 1–2 项、家族不重复；原样带出，字段顺序不变", () => {
    for (const body of [RESULT, DELIVER]) {
      for (const usage of [[CLAUDE], [CODEX], [CLAUDE, CODEX]]) {
        const r = parse({ ...body, usage });
        expect(r).toMatchObject({ ok: true, value: { usage } });
      }
    }
    const r = parse({ ...RESULT, actual: { model: null, effort: "high", source: "suggest" }, usage: [CODEX] });
    expect(r.ok && Object.keys(r.value)).toEqual(["v", "orderId", "gen", "verdict", "report", "session", "actual", "usage"]);
  });

  test("上限本身收：token 1e12、调用 1e7；reasoning 也在上限内", () => {
    const top = { ...CODEX, input: USAGE_TOKEN_MAX, output: USAGE_TOKEN_MAX, cacheRead: USAGE_TOKEN_MAX, cacheWrite: USAGE_TOKEN_MAX, reasoning: USAGE_TOKEN_MAX,
      calls: USAGE_CALLS_MAX };
    expect(parse({ ...RESULT, usage: [top] }).ok).toBe(true);
  });

  test("不带 usage：结果里没有 usage 键，与改前同形", () => {
    for (const body of [RESULT, DELIVER]) {
      const r = parse(body);
      expect(r.ok).toBe(true);
      expect(r.ok && r.value).not.toHaveProperty("usage");
    }
    const r = parse(RESULT);
    expect(r.ok && Object.keys(r.value)).toEqual(["v", "orderId", "gen", "verdict", "report", "session"]);
  });
});

describe("[验收线 1] 不合格整条 invalid", () => {
  const cases: [string, unknown][] = [
    ["负数", [{ ...CLAUDE, input: -1 }]],
    ["reasoning 负数", [{ ...CODEX, reasoning: -1 }]],
    ["小数", [{ ...CLAUDE, output: 1.5 }]],
    ["超上限 token", [{ ...CLAUDE, cacheRead: USAGE_TOKEN_MAX + 1 }]],
    ["超上限 reasoning", [{ ...CODEX, reasoning: USAGE_TOKEN_MAX + 1 }]],
    ["超上限调用", [{ ...CLAUDE, calls: USAGE_CALLS_MAX + 1 }]],
    ["调用 0", [{ ...CLAUDE, calls: 0 }]],
    ["字符串数字", [{ ...CLAUDE, input: "10" }]],
    ["家族不认识", [{ ...CLAUDE, family: "gemini" }]],
    ["多于 2 项", [CLAUDE, CODEX, CLAUDE]],
    ["家族重复", [CLAUDE, CLAUDE]],
    ["空数组", []],
    ["不是数组", CLAUDE],
    ["null", null],
    ["多字段（提示词）", [{ ...CLAUDE, prompt: "hi" }]],
    ["多字段（金额）", [{ ...CLAUDE, costUsd: 1 }]],
    ["缺字段", [{ family: "claude", input: 1, output: 1, cacheRead: 1, cacheWrite: 1, calls: 1, firstAt: 1, lastAt: 1 }]],
    ["最晚早于最早", [{ ...CLAUDE, firstAt: 3_000, lastAt: 2_000 }]],
    ["时刻为 0", [{ ...CLAUDE, firstAt: 0 }]],
  ];
  for (const [name, usage] of cases) {
    test(name, () => {
      for (const r of bad(usage)) {
        expect(r.ok).toBe(false);
        expect(!r.ok && r.error).toMatch(/^usage/);
      }
    });
  }
});

describe("[验收线 2] 声明方式：hello 应答 proto 4，老 B 的解析不报错", () => {
  test("本机的 hello 应答说 proto 4；老 B 用的解析函数（parseV2Response，本卡没动）原样收下，键与改前一样", () => {
    expect(LEND_PROTO).toBe(4);
    const answer = { ok: true, v: 1, ...helloAnswer() };
    expect(Object.keys(answer)).toEqual(["ok", "v", "proto", "helloMs", "beatMs"]); // 没加新字段：老 B 的 fields() 严格收键不会拒
    expect(parseV2Response("hello", answer)).toEqual({ ok: true, value: { proto: 4, helloMs: 60_000, beatMs: 15_000 } });
    // 老 B 只校验 proto 是 1–99 的整数（lend-wire-v2.ts RESPONSES.hello），更高的代也收
    expect(parseV2Response("hello", { ...answer, proto: 99 }).ok).toBe(true);
  });

  test("应答里多一个能力字段会被老 B 整条拒——所以不走这条路", () => {
    expect(parseV2Response("hello", { ok: true, v: 1, ...helloAnswer(), caps: ["usage"] })).toMatchObject({ ok: false, error: expect.stringContaining("caps") });
  });
});
