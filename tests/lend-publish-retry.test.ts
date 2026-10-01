/**
 * i28-PUB1 B 侧：写单交活后「推送 / 开 PR」可重试的失败——原因进 publishing 心跳摘要（proto 2 beat）、连续 30 分钟停单并告诉 A（交 PM）、
 * 中途 A 代开了 PR 时 B 下一轮查到现成 PR 照常交付并清掉失败记账；ensurePr 查到同分支开着的 PR 就直接用、不再开。A 与 gh 都是假的。
 */
import { describe, expect, test } from "bun:test";
import { workerName } from "../src/lib/lend-drive.js";
import { lendBranch } from "../src/lib/lend-git.js";
import { advance, getOrder, localDay, recordAsked } from "../src/lib/lend-journal.js";
import { publishFail, PUBLISH_GIVE_UP_MS } from "../src/lib/lend-pr-takeover-retry.js";
import { ensurePr, type PrResult } from "../src/lib/lend-push.js";
import type { BoundedResult } from "../src/lib/run-bounded.js";
import { FP, harness, polled, TEXT, wire } from "./lend-harness.js";

const BR = lendBranch("T93", FP)!;
const H2 = "c".repeat(40);
const MIN = 60_000;

/** 直接在 journal 里造一张写单，停在 worker 已交活（work 落了、还没推送 / 开 PR）= phase publishing */
function publishing(h: ReturnType<typeof harness>, id = "w1") {
  const now = h.d.now();
  recordAsked(h.db, { orderId: id, peer: "team-a", fp: FP, family: "codex", preview: { ...polled(id), step: "write", pr: null } }, now);
  const order = { ...wire(id), node: "write", step: "write", pr: null };
  advance(h.db, id, "asked", "claimed", { wire: { order, text: TEXT, write: { branch: BR, base: "main" } }, day: localDay(now), leaseGen: 1,
    leaseUntil: now + 600_000, lastBeatAt: now }, now);
  advance(h.db, id, "claimed", "cloned", { dir: `/lend/work/${id}` }, now);
  const agent = workerName(id);
  h.registry.set(agent, { sessionId: `s-${id}`, cwd: `/lend/work/${id}` });
  advance(h.db, id, "cloned", "started", { agent, sessionId: `s-${id}`, startedAt: now, submit: "sent", notices: { start: now } }, now);
  advance(h.db, id, "started", "result_pending", { work: { head: H2, summary: "实现了 x", selfCheck: "逐条对了" } }, now);
}

/** 出借声明开了 write；pr 依次给出 answers 里的结果，用完之后一直是最后一个 */
function writeHarness(answers: PrResult[]) {
  const h = harness({ entry: { roles: ["review", "write"] } });
  const prCalls: number[] = [];
  h.d.push.pr = async () => (prCalls.push(h.d.now()), answers.length > 1 ? answers.shift()! : answers[0]);
  publishing(h);
  return { h, prCalls };
}

const RETRY: PrResult = { ok: false, retry: true, reason: "查 PR 失败：HTTP 502 Bad Gateway" };
const release = (h: ReturnType<typeof harness>) => h.calls.find((c) => c.op === "lease" && c.body.action === "release")?.body;

describe("可重试失败：心跳摘要带原因", () => {
  test("proto 2：publishing 那一行的摘要是「开 PR 失败：<原因>」，不读 worker 输出；脱敏照旧", async () => {
    const { h } = writeHarness([{ ...RETRY, reason: "开 PR 失败：token ghp_abcdefghijklmnopqrstuvwxyz0123456789 无效" }]);
    const beats: { orderId: string; phase: string; excerpt: string }[][] = [];
    let read = 0;
    h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [], pollAfterMs: 30_000 } });
    h.d.v2 = { boot: "boot-pub1-0001", excerpt: async () => (read++, { text: "worker 输出", at: 1 }), call: async (_p, op, body) => {
      if (op === "hello") return { status: 200, body: { ok: true, v: 1, proto: 2, helloMs: 60_000, beatMs: 15_000 } };
      const lines = body.orders as { orderId: string; gen: number; phase: string; excerpt: string }[];
      beats.push(lines);
      return { status: 200, body: { ok: true, v: 1, orders: lines.map((l) => ({ orderId: l.orderId, verdict: "ok", lease: { gen: l.gen, expiresAt: 0, ms: 600_000 } })) } };
    } };
    await h.tick(); // 这一轮的 beat 在推送之前：还没有失败记账，摘要照旧读 worker 输出
    const before = read;
    for (let i = 0; i < 2; i++) { h.advanceTime(16_000); await h.tick(); }
    const last = beats.at(-1)!.find((l) => l.orderId === "w1")!;
    expect(last.phase).toBe("publishing");
    expect(last.excerpt).toStartWith("开 PR 失败：开 PR 失败：token");
    expect(last.excerpt).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(read).toBe(before);
    expect(getOrder(h.db, "w1")!.state).toBe("result_pending");
  });

  test("首次失败时刻沿用、原因换成最新的；不可重试的失败不记账、直接停", async () => {
    const { h } = writeHarness([RETRY, { ...RETRY, reason: "开 PR 失败：超时" }]);
    await h.tick();
    const first = publishFail(h.db, "w1")!;
    h.advanceTime(5 * MIN);
    await h.tick();
    expect(publishFail(h.db, "w1")).toEqual({ since: first.since, reason: "开 PR 失败：超时" });

    const { h: h2 } = writeHarness([{ ok: false, retry: false, reason: "没有推送权限" }]);
    await h2.tick();
    expect(getOrder(h2.db, "w1")!.state).toBe("stopped");
    expect(publishFail(h2.db, "w1")).toBeNull();
  });
});

describe("连续失败超过 30 分钟：停单并告诉 A", () => {
  test("30 分钟内一直重试、续租照常；过了就 stopped，release reason=stopped、detail 写明原因", async () => {
    const { h, prCalls } = writeHarness([RETRY]);
    await h.tick();
    for (let t = 5; t < PUBLISH_GIVE_UP_MS / MIN; t += 5) {
      h.advanceTime(5 * MIN);
      await h.tick();
      expect(getOrder(h.db, "w1")!.state).toBe("result_pending");
    }
    expect(release(h)).toBeUndefined();
    h.advanceTime(5 * MIN);
    await h.tick();
    expect(getOrder(h.db, "w1")!.state).toBe("stopped");
    expect(release(h)).toMatchObject({ reason: "stopped" });
    expect(String(release(h)!.detail)).toContain("30 分钟");
    expect(String(release(h)!.detail)).toContain("HTTP 502");
    expect(h.ops()).not.toContain("result");
    const tries = prCalls.length;
    h.advanceTime(5 * MIN);
    await h.tick();
    expect(prCalls).toHaveLength(tries);
    expect(publishFail(h.db, "w1")).toBeNull();
  });
});

describe("中途 A 代开了 PR", () => {
  test("B 下一轮查到现成 PR → 照常交付（PR 号是 A 开的那个）、失败记账清掉", async () => {
    const { h } = writeHarness([RETRY, RETRY, { ok: true, pr: 377 }]);
    await h.tick();
    h.advanceTime(6 * MIN);
    await h.tick();
    expect(publishFail(h.db, "w1")).not.toBeNull();
    h.advanceTime(MIN);
    await h.tick();
    expect(getOrder(h.db, "w1")!.state).toBe("acked");
    expect(h.calls.find((c) => c.op === "result")!.body).toMatchObject({ branch: BR, pr: 377, deliver: { head: H2 } });
    expect(publishFail(h.db, "w1")).toBeNull();
  });

  test("ensurePr：同分支已有开着的 PR（A 代开的）就用它，不再 gh pr create；gh pr list 本身失败 = 可重试", async () => {
    const argv: string[][] = [];
    const ok = (stdout: string): BoundedResult => ({ code: 0, stdout, stderr: "", timedOut: false } as BoundedResult);
    const input = { orderId: "w1", repo: "o/r", branch: BR, base: "main", pr: null, title: "t", body: "b" };
    const found = await ensurePr(input, { env: {}, root: "/nonexistent-lend-root", run: async (a) => (argv.push(a), ok("377\n")) });
    expect(found).toEqual({ ok: true, pr: 377 });
    expect(argv.map((a) => a.slice(0, 3).join(" "))).toEqual(["gh pr list"]);
    const bad = await ensurePr(input, { env: {}, root: "/nonexistent-lend-root",
      run: async () => ({ code: 1, stdout: "", stderr: "HTTP 502", timedOut: false } as BoundedResult) });
    expect(bad).toMatchObject({ ok: false, retry: true });
  });
});
