/**
 * TIER1b 出借方 B 这一半（lend 循环，tests/lend-harness.ts 的假 A、假 worker、内存 journal）：claim 带 caps、旧 A 不认时去掉重发并记住、
 * 建议严格校验后进 journal、起 worker 的参数只来自出借授权（建议不改 argv、不多起）、交付 / 结论正文只在 A 给过建议时带 actual。
 * 借入方 A 那一半在 tests/role-model-lend.test.ts。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ENTRY, harness, sha, TEXT, toStarted, wire } from "./lend-harness.js";
import { lendModelArgs } from "../src/lib/lend-grant-spawn.js";
import { getOrder } from "../src/lib/lend-journal.js";
import { commitLendResult } from "../src/lib/lend-submit.js";
import type { ModelSuggest } from "../src/lib/lend-wire-types.js";
import { deliveredActual, recordLendLaunch } from "../src/lib/role-model-settings-lend.js";
import { suggestDigest } from "../src/lib/role-model-settings-wire.js";

type H = ReturnType<typeof harness>;
const LEASE = { gen: 1, expiresAt: 0, ms: 600_000 };
const HIGH: ModelSuggest = { effort: "high", source: "settings" };
/** 新 A、开关 on：claim 带了 caps 就附建议，摘要把建议算进去 */
const suggesting = (h: H, s: ModelSuggest = HIGH, digest = suggestDigest(TEXT, s)) => {
  h.A.claim = (b) => ({ status: 200, body: { ok: true, v: 1, order: wire(String(b.orderId)), text: TEXT, lease: LEASE,
    ...(Array.isArray(b.caps) ? { sha256: digest, suggest: s } : { sha256: sha(TEXT) }) } });
};
const claims = (h: H) => h.calls.filter((c) => c.op === "claim").map((c) => c.body);
const INPUT = { verdict: "pass", findings: [], report: "## 结论\n通过" };
/** 走到 started，再由 worker 交结论（lend-deps 的 worker.create 是假的：起 worker 那一下的记账在这里按同样的参数补上） */
async function reviewed(h: H, args: string[] | null): Promise<Record<string, unknown>> {
  await toStarted(h);
  if (args) recordLendLaunch(h.db, "o1", args);
  expect(commitLendResult(h.db, getOrder(h.db, "o1")!, INPUT, 2_000_000)).toMatchObject({ ok: true, duplicate: false });
  return getOrder(h.db, "o1")!.payload!;
}

describe("[验收线 1] 旧 A（不认 caps）", () => {
  test("claim 先带 caps；对方明确回 invalid 才去掉重发一次，单照常领到；之后一天内不再带", async () => {
    const h = harness();
    const plain = h.A.claim;
    h.A.claim = (b) => ("caps" in b ? { status: 400, body: { ok: false, code: "invalid", error: "$: 不认识的字段 caps" } } : plain(b));
    await h.tick(); await h.tick();
    expect(claims(h)).toEqual([{ v: 1, orderId: "o1", worker: expect.any(String), caps: ["suggest"] }, { v: 1, orderId: "o1", worker: expect.any(String) }]);
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "claimed", wire: { text: TEXT } });
    expect(getOrder(h.db, "o1")!.wire).not.toHaveProperty("suggest");
    expect(deliveredActual(h.db, getOrder(h.db, "o1")!)).toEqual({}); // 没有建议 = 不知道 A 认不认 actual：不带
  });

  test("没给建议的 A：结论正文没有 actual 字段，与改前同形；起 worker 一次", async () => {
    const h = harness();
    const payload = await reviewed(h, ["--effort", "high"]);
    expect(Object.keys(payload)).toEqual(["v", "orderId", "gen", "verdict", "report", "session"]);
    expect(h.log.created.length).toBe(1);
    await h.tick();
    expect(h.calls.find((c) => c.op === "result")!.body).not.toHaveProperty("actual");
    expect(getOrder(h.db, "o1")!.state).toBe("acked");
  });

  test("别的拒绝码不重发：max_open 照旧留着下轮再试，仍带 caps", async () => {
    const h = harness();
    h.A.claim = () => ({ status: 429, body: { ok: false, code: "max_open", error: "满了" } });
    await h.tick(); await h.tick();
    expect(claims(h).length).toBe(1);
    await h.tick();
    expect(claims(h).every((b) => Array.isArray(b.caps))).toBe(true);
    expect(getOrder(h.db, "o1")!.state).toBe("asked");
  });
});

describe("[验收线 2] 新 A 给了建议", () => {
  test("建议核过摘要后进 journal；结论正文带起 worker 时记下的 actual，A 的回执带回同一份才算入账", async () => {
    const h = harness();
    suggesting(h);
    h.A.result = (b) => ({ status: 200, body: { ok: true, v: 1, receipt: { orderId: b.orderId, sha256: sha(JSON.stringify(b)), eventSeq: 9, taskId: "T93", key: "k", sig: "s", actual: b.actual } } });
    const payload = await reviewed(h, ["--effort", "high"]);
    expect(getOrder(h.db, "o1")!.wire!.suggest).toEqual(HIGH);
    expect(payload.actual).toEqual({ model: null, effort: "high", source: "suggest" });
    await h.tick();
    expect(h.calls.find((c) => c.op === "result")!.body.actual).toEqual({ model: null, effort: "high", source: "suggest" });
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "acked", receipt: { actual: { effort: "high" } } });
  });

  test("摘要对不上（建议被改 / 旧摘要配了建议）：不领，下轮再试，journal 里没有建议", async () => {
    for (const digest of [suggestDigest(TEXT, { effort: "max", source: "settings" }), sha(TEXT)]) {
      const h = harness();
      suggesting(h, HIGH, digest);
      await h.tick(); await h.tick();
      expect(getOrder(h.db, "o1")).toMatchObject({ state: "asked", wire: null });
      expect(h.log.lines.some((l) => l.includes("bad_response"))).toBe(true);
    }
  });

  test("回执带回的 actual 不是本机报的那一份：不算入账，停单", async () => {
    const h = harness();
    suggesting(h);
    h.A.result = (b) => ({ status: 200, body: { ok: true, v: 1, receipt: { orderId: b.orderId, sha256: sha(JSON.stringify(b)), eventSeq: 9, taskId: "T93", key: "k", sig: "s",
      actual: { model: null, effort: "max", source: "suggest" } } } });
    await reviewed(h, ["--effort", "high"]);
    await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "stopped", reason: expect.stringContaining("actual") });
  });

  test("起 worker 时没记到事实（升级前起的 worker）：不编，正文不带 actual", async () => {
    const h = harness();
    suggesting(h);
    expect(await reviewed(h, null)).not.toHaveProperty("actual");
  });
});

describe("[验收线 3] 授权上限、Codex 只有推理档", () => {
  test("codex 单的建议带了模型名：与挂单不符，退回（not_started），不起 worker", async () => {
    const h = harness();
    suggesting(h, { model: "claude-opus-5-5", source: "settings" });
    await h.tick(); await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "released", reason: expect.stringContaining("suggest") });
    expect(h.log.created).toEqual([]);
  });

  test("建议档没开放 → 用授权里开放的那一档并有诊断；授权没写档 → 对方原默认并有诊断；actual 里没有模型名", async () => {
    const h = harness();
    suggesting(h, { effort: "xhigh", source: "settings" });
    await toStarted(h);
    expect(recordLendLaunch(h.db, "o1", ["--model", "gpt-9-codex", "--effort", "medium"])).toContain("最接近的 medium");
    expect(deliveredActual(h.db, getOrder(h.db, "o1")!)).toEqual({ actual: { model: null, effort: "medium", source: "grant" } });
    expect(recordLendLaunch(h.db, "o1", [])).toContain("照对方原默认");
    expect(deliveredActual(h.db, getOrder(h.db, "o1")!)).toEqual({ actual: { model: null, effort: null, source: "default" } });
    expect(recordLendLaunch(h.db, "o1", ["--effort", "xhigh"])).toBeNull();
    expect(deliveredActual(h.db, getOrder(h.db, "o1")!)).toEqual({ actual: { model: null, effort: "xhigh", source: "suggest" } });
  });
});

describe("[验收线 4] 建议不改启动", () => {
  /** 一份真的 lend.json（临时目录）：出借授权里写了 codexEffort */
  const lendFile = (effort?: string): string => {
    const p = join(mkdtempSync(join(tmpdir(), "role-model-lend-peer-")), "lend.json");
    writeFileSync(p, JSON.stringify({ version: 2, enabled: true, lend: [{ ...ENTRY, ...(effort ? { codexEffort: effort } : {}) }], borrow: [] }));
    return p;
  };

  test("带不带建议，起 worker 的 argv 一样（只看出借授权），也只起一次", async () => {
    const argv: string[][] = [];
    for (const suggest of [null, { effort: "max", source: "settings" } as ModelSuggest]) {
      const h = harness();
      if (suggest) suggesting(h, suggest);
      await toStarted(h);
      expect(h.log.created.length).toBe(1);
      argv.push(lendModelArgs(h.db, "o1", lendFile("medium")), lendModelArgs(h.db, "o1", lendFile()));
    }
    expect(argv).toEqual([["--effort", "medium"], [], ["--effort", "medium"], []]);
  });

  test("A 是 observe / off（不给建议）：claim 仍只发一次，结论正文与改前同形", async () => {
    const h = harness();
    const payload = await reviewed(h, []);
    expect(claims(h).length).toBe(1);
    expect(payload).not.toHaveProperty("actual");
    expect(h.log.created.length).toBe(1);
  });
});
