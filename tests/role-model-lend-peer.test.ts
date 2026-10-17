/**
 * TIER1b 出借方 B 这一半（lend 循环，tests/lend-harness.ts 的假 A、假 worker、内存 journal）：claim 带 caps、旧 A 不认时去掉重发并记住、
 * 建议严格校验后进 journal、起 worker 的参数只来自出借授权（建议不改 argv、不多起）、交付 / 结论正文只在 A 给过建议时带 actual。
 * 借入方 A 那一半在 tests/role-model-lend.test.ts。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ENTRY, FP, harness, polled, sha, TEXT, toStarted, wire } from "./lend-harness.js";
import { lendModelArgs } from "../src/lib/lend-grant-spawn.js";
import { advance, getOrder, localDay, recordAsked } from "../src/lib/lend-journal.js";
import { commitLendResult } from "../src/lib/lend-submit.js";
import type { ModelSuggest } from "../src/lib/lend-wire-types.js";
import { deliveredActual, launchRecording, recordLendLaunch, resetNoTier } from "../src/lib/role-model-settings-lend.js";
import { suggestDigest } from "../src/lib/role-model-settings-wire.js";
import { useTaskTierPort } from "../src/lib/task-tier-models.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";

type H = ReturnType<typeof harness>;
/** B 本机 taskTierModels 恢复键：TIER1b 的用例钉 off（TIER3b 的门关 = 与改前逐字一致），TIER3b 的协商用例自己开 */
const tierKey = (mode: RecoveryMode) => useTaskTierPort({ policy: (_p: string, key: string) => ({ mode: key === "taskTierModels" ? mode : "on", manualAfterMs: null, source: "config" as const }) });
beforeEach(() => { tierKey("off"); resetNoTier(); });
afterEach(() => { useTaskTierPort(); resetNoTier(); });
const LEASE = { gen: 1, expiresAt: 0, ms: 600_000 };
const HIGH: ModelSuggest = { effort: "high", source: "settings" };
/** 新 A、开关 on：claim 带了 caps 就附建议，摘要把建议算进去 */
const suggesting = (h: H, s: ModelSuggest = HIGH, digest = suggestDigest(TEXT, s)) => {
  h.A.claim = (b) => ({ status: 200, body: { ok: true, v: 1, order: wire(String(b.orderId)), text: TEXT, lease: LEASE,
    ...(Array.isArray(b.caps) ? { sha256: digest, suggest: s } : { sha256: sha(TEXT) }) } });
};
const claims = (h: H) => h.calls.filter((c) => c.op === "claim").map((c) => c.body);
const INPUT = { verdict: "pass", findings: [], report: "## 结论\n通过" };
/** 走到 started，再由 worker 交结论（lend-deps 的 worker.create 是假的：建成那一下的记账在这里按同样的参数、假 worker 的会话 id 补上） */
async function reviewed(h: H, args: string[] | null): Promise<Record<string, unknown>> {
  await toStarted(h);
  if (args) recordLendLaunch(h.db, "o1", "thr-1", args);
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

describe("TIER3b 协商 caps=tier（B 本机门开）", () => {
  test("[验收线 2] 旧 A 不认 tier：先只去掉 tier 按 [suggest] 重发，单照常领到、建议照旧；之后一天内只带 suggest", async () => {
    tierKey("on");
    const h = harness();
    suggesting(h);
    const plain = h.A.claim;
    h.A.claim = (b) => (Array.isArray(b.caps) && b.caps.includes("tier") ? { status: 400, body: { ok: false, code: "invalid", error: "caps[1]: 不认识" } } : plain(b));
    await h.tick(); await h.tick();
    expect(claims(h)).toEqual([{ v: 1, orderId: "o1", worker: expect.any(String), caps: ["suggest", "tier"] }, { v: 1, orderId: "o1", worker: expect.any(String), caps: ["suggest"] }]);
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "claimed", wire: { text: TEXT, suggest: HIGH } });
  });

  test("[验收线 1] 新 A 回带类型的建议：B 核过摘要（tier / role 在摘要里）原样进 journal；摘要不含类型的回包不领", async () => {
    tierKey("on");
    const tagged: ModelSuggest = { effort: "low", source: "default", tier: "security", role: "author" };
    const h = harness();
    suggesting(h, tagged);
    await h.tick(); await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "claimed", wire: { suggest: tagged } });
    const h2 = harness();
    suggesting(h2, tagged, suggestDigest(TEXT, { effort: "low", source: "default" }));
    await h2.tick(); await h2.tick();
    expect(getOrder(h2.db, "o1")!.state).not.toBe("claimed");
  });

  test("[验收线 2] 更旧的 A（caps 都不认）：每次领单最多重发一次；这次只去掉 tier，下轮走旧的去掉 caps 回落，照样领到", async () => {
    tierKey("on");
    const h = harness();
    const plain = h.A.claim;
    h.A.claim = (b) => ("caps" in b ? { status: 400, body: { ok: false, code: "invalid", error: "$: 不认识的字段 caps" } } : plain(b));
    await h.tick(); await h.tick();
    expect(claims(h).map((b) => b.caps ?? null)).toEqual([["suggest", "tier"], ["suggest"]]);
    expect(getOrder(h.db, "o1")!.state).toBe("asked"); // 没被当成拒单
    await h.tick();
    expect(claims(h).map((b) => b.caps ?? null)).toEqual([["suggest", "tier"], ["suggest"], ["suggest"], null]);
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "claimed", wire: { text: TEXT } });
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

describe("[验收线 2] 启动事实跟着会话走（创建竞争）", () => {
  const MEDIUM = ["create", "w", "/d", "--effort", "medium"];
  /**
   * 开跑通知那一下的工夫里，同名 worker 被别处按当时授权的 high 建好（winner-high）；本机随后按改过的授权（medium）去建，
   * manager 回「已存在」，startWorker 认领 winner-high。worker.create 走生产同一条 launchRecording 接线，manager 是假的。
   */
  async function raced(winnerRecorded: boolean): Promise<Record<string, unknown>> {
    const h = harness();
    suggesting(h);
    const gated = h.d.worker.create;
    h.d.worker.create = async (n, dir, purpose, gate, order) => {
      const denied = await gate();
      if (denied) return { ok: false, error: denied };
      const r = await launchRecording(h.db, order, async () => ({ ok: false, error: `${n} already exists` }), (m) => void h.log.lines.push(m))(...MEDIUM);
      return r.ok === true ? gated(n, dir, purpose, gate, order) : { ok: false, error: String(r.error) };
    };
    for (let i = 0; i < 3; i++) await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("cloned");
    h.inform.onSend = () => {
      const row = getOrder(h.db, "o1")!;
      h.registry.set(row.agent!, { sessionId: "winner-high", cwd: row.dir! });
      if (winnerRecorded) void launchRecording(h.db, "o1", async () => ({ ok: true, sessionId: "winner-high" }), () => {})("create", "w", "/d", "--effort", "high");
    };
    for (let i = 0; i < 3; i++) await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "started", sessionId: "winner-high" });
    expect(h.log.created).toEqual([]); // 本机这次没建成
    expect(commitLendResult(h.db, getOrder(h.db, "o1")!, INPUT, 2_000_000)).toMatchObject({ ok: true, duplicate: false });
    return getOrder(h.db, "o1")!.payload!;
  }

  test("没建成的那次（medium）不落账：认领的会话没有事实 → 结论正文不带 actual（A 记 unknown）", async () => {
    expect(await raced(false)).not.toHaveProperty("actual");
  });

  test("建成它的那次记过（high）：没建成的 medium 不盖掉，结论带的是这个会话自己的 high", async () => {
    expect((await raced(true)).actual).toEqual({ model: null, effort: "high", source: "suggest" });
  });

  test("manager 回 ok 但没报会话 id：不记（绑不到会话的事实不算数）", async () => {
    const h = harness();
    suggesting(h);
    await toStarted(h);
    await launchRecording(h.db, "o1", async () => ({ ok: true }), () => {})(...MEDIUM);
    expect(deliveredActual(h.db, getOrder(h.db, "o1")!)).toEqual({});
  });

  /** 写单（开工 / 修复）：直接在 journal 里造到 worker 已交活，会话是 session；launched = 记下的启动事实属于哪个会话 */
  async function wrote(session: string, launched: string | null): Promise<Record<string, unknown>> {
    const h = harness({ entry: { roles: ["review", "write"] } });
    const now = h.d.now();
    recordAsked(h.db, { orderId: "w1", peer: "team-a", fp: FP, family: "codex", preview: { ...polled("w1"), step: "write", pr: null } }, now);
    advance(h.db, "w1", "asked", "claimed", { wire: { order: { ...wire("w1"), node: "write", step: "write", pr: null }, text: TEXT, suggest: HIGH,
      write: { branch: "lend/T93-x", base: "main" } }, day: localDay(now), leaseGen: 1, leaseUntil: now + 600_000, lastBeatAt: now }, now);
    advance(h.db, "w1", "claimed", "cloned", { dir: "/lend/work/w1" }, now);
    h.registry.set("lend-w1", { sessionId: session, cwd: "/lend/work/w1" });
    advance(h.db, "w1", "cloned", "started", { agent: "lend-w1", sessionId: session, startedAt: now, submit: "sent", notices: { start: now } }, now);
    if (launched) await launchRecording(h.db, "w1", async () => ({ ok: true, sessionId: launched }), () => {})(...MEDIUM);
    await launchRecording(h.db, "w1", async () => ({ ok: false, error: "already exists" }), () => {})("create", "w", "/d", "--effort", "low");
    advance(h.db, "w1", "started", "result_pending", { work: { head: "c".repeat(40), summary: "实现了 x", selfCheck: "逐条对了" } }, now);
    h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [], pollAfterMs: 30_000 } });
    await h.tick();
    const payload = getOrder(h.db, "w1")!.payload!;
    expect(payload).toMatchObject({ deliver: { orderId: "w1" }, session: { id: session } });
    return payload;
  }

  test("写单交付：事实是别的会话的 / 没记到 → 不带 actual；是本会话的 → 带，后来没建成的那次不盖掉", async () => {
    expect(await wrote("winner-high", "loser-medium")).not.toHaveProperty("actual");
    expect(await wrote("winner-high", null)).not.toHaveProperty("actual");
    expect((await wrote("s-w1", "s-w1")).actual).toEqual({ model: null, effort: "medium", source: "grant" });
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
    expect(recordLendLaunch(h.db, "o1", "thr-1", ["--model", "gpt-9-codex", "--effort", "medium"])).toContain("最接近的 medium");
    expect(deliveredActual(h.db, getOrder(h.db, "o1")!)).toEqual({ actual: { model: null, effort: "medium", source: "grant" } });
    expect(recordLendLaunch(h.db, "o1", "thr-1", [])).toContain("照对方原默认");
    expect(deliveredActual(h.db, getOrder(h.db, "o1")!)).toEqual({ actual: { model: null, effort: null, source: "default" } });
    expect(recordLendLaunch(h.db, "o1", "thr-1", ["--effort", "xhigh"])).toBeNull();
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
