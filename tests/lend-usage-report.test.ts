/**
 * LENDUSAGE1 出借方 B 这一半（src/lib/lend-usage-report.ts，经 lend-submit.ts / lend-drive.ts / lend-hello.ts 接线）：
 * 开关 lendUsageReport 缺省 off、只认显式键；先认后发（借入方 hello 应答 proto ≥ 4 才带，每次握手覆盖）；只算这一单 worker 会话、查不到不带。
 * lend 循环用 tests/lend-harness.ts 的假 A、内存 journal；usage 库是临时文件里的真 schema。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FP, harness, polled, TEXT, toStarted, wire } from "./lend-harness.js";
import { advance, getMeta, getOrder, localDay, openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import { commitLendResult } from "../src/lib/lend-submit.js";
import {
  lendUsageFor, OBSERVED_KEEP_MS, pruneUsageObserved, readSessionUsage, usageAcked, usageAckKey, usageObserved, usageReportMode, useUsageReportDeps, writeUsageAck,
  type LendUsage,
} from "../src/lib/lend-usage-report.js";
import { HELLO_FRESH_MS } from "../src/lib/lend-wire-v2.js";
import { openUsageDb } from "../src/lib/usage-store.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";

const tmp = mkdtempSync(join(tmpdir(), "lend-usage-report-"));
const USAGE: LendUsage[] = [{ family: "codex", input: 10, output: 20, cacheRead: 30, cacheWrite: 0, reasoning: 5, calls: 2, firstAt: 100, lastAt: 200 }];
const INPUT = { verdict: "pass", findings: [], report: "## 结论\n通过" };
const PEER = "team-a";

afterEach(() => useUsageReportDeps(null));

/** 注入开关与读库；reads 记下被查过的会话 */
function inject(mode: RecoveryMode, usage: LendUsage[] | null = USAGE) {
  const reads: string[] = [], lines: string[] = [];
  useUsageReportDeps({ mode: () => mode, read: (sid) => (reads.push(sid), usage), log: (l) => void lines.push(l) });
  return { reads, lines };
}

describe("[验收线 3] 开关：缺省 off，只认 lendUsageReport 的显式值", () => {
  const repo = join(tmp, "repo");
  mkdirSync(repo, { recursive: true });
  const projects = join(tmp, "projects.json");
  writeFileSync(projects, JSON.stringify({ projects: [{ id: "cs", name: "cs", dirs: [repo], createdAt: "2026-01-01" }] }));
  const policy = (p: unknown) => { const f = join(tmp, `policy-${Math.random()}.json`); writeFileSync(f, typeof p === "string" ? p : JSON.stringify(p)); return f; };
  const mode = (policyPath: string, o: { projectsPath?: string; repoRoot?: string } = {}) => usageReportMode({ policyPath, projectsPath: projects, repoRoot: repo, ...o });

  test("没有策略文件 / 项目没条目 / 项目整体 on 或 observe 但没设这个键：都是 off", () => {
    expect(mode(join(tmp, "missing.json"))).toBe("off");
    expect(mode(policy({ projects: {} }))).toBe("off");
    expect(mode(policy({ projects: { cs: { mode: "on" } } }))).toBe("off");
    expect(mode(policy({ projects: { cs: { mode: "observe", keys: { lendUiShots: "on" } } } }))).toBe("off");
  });

  test("显式 observe / on / off 照给；别的项目设了不算", () => {
    for (const m of ["observe", "on", "off"] as const) expect(mode(policy({ projects: { cs: { keys: { lendUsageReport: m } } } }))).toBe(m);
    expect(mode(policy({ projects: { other: { keys: { lendUsageReport: "on" } } } }))).toBe("off");
  });

  test("文件坏、项目解析不出、projects.json 读不了：off，不抛", () => {
    expect(mode(policy("{ not json"))).toBe("off");
    expect(mode(policy({ projects: { cs: { keys: { lendUsageReport: "maybe" } } } }))).toBe("off");
    const on = policy({ projects: { cs: { keys: { lendUsageReport: "on" } } } });
    expect(mode(on, { repoRoot: join(tmp, "elsewhere") })).toBe("off");
    expect(mode(on, { projectsPath: join(tmp, "nope.json") })).toBe("off");
  });

  test("测试环境的真读法（隔离的状态目录里没有策略）：off", () => {
    expect(usageReportMode()).toBe("off");
  });
});

describe("[验收线 2] 借入方的声明：每次握手覆盖", () => {
  test("proto ≥ 4 才算认识；3 / 0 覆盖成不认识；超过 HELLO_FRESH_MS 没刷新当不认识", () => {
    const db = openLendJournal(":memory:");
    expect(usageAcked(db, PEER, 1_000)).toBe(false); // 没握过
    writeUsageAck(db, PEER, 4, 1_000);
    expect(usageAcked(db, PEER, 1_000)).toBe(true);
    expect(usageAcked(db, PEER, 1_000 + HELLO_FRESH_MS)).toBe(true);
    expect(usageAcked(db, PEER, 1_001 + HELLO_FRESH_MS)).toBe(false);
    writeUsageAck(db, PEER, 3, 2_000);
    expect(usageAcked(db, PEER, 2_000)).toBe(false); // 对方降级：旧的 true 被盖掉
    writeUsageAck(db, PEER, 99, 3_000);
    expect(usageAcked(db, PEER, 3_000)).toBe(true);
    writeUsageAck(db, PEER, 0, 4_000);
    expect(usageAcked(db, PEER, 4_000)).toBe(false);
    expect(usageAcked(db, "other", 4_000)).toBe(false);
  });

  test("hello 走 lend 循环：A 应答 proto 4 记认识，3 记不认识，404（旧版没有 v2）也记不认识", async () => {
    const h = harness();
    let answer: { status: number; body: unknown } = { status: 200, body: { ok: true, v: 1, proto: 4, helloMs: 60_000, beatMs: 15_000 } };
    h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [], pollAfterMs: 30_000 } });
    h.d.v2 = { boot: "boot-aaaa-0001", call: async (_p, op) => (op === "hello" ? answer : { status: 200, body: { ok: true, v: 1, orders: [] } }) };
    const acked = () => usageAcked(h.db, PEER, h.d.now());
    await h.tick();
    expect(acked()).toBe(true);
    expect(getMeta(h.db, "proto:team-a")).toBe("2"); // setProto 钳成 2 的逻辑不动
    answer = { status: 200, body: { ok: true, v: 1, proto: 3, helloMs: 60_000, beatMs: 15_000 } };
    h.advanceTime(61_000); await h.tick();
    expect(acked()).toBe(false);
    answer = { status: 200, body: { ok: true, v: 1, proto: 4, helloMs: 60_000, beatMs: 15_000 } };
    h.advanceTime(61_000); await h.tick();
    expect(acked()).toBe(true);
    answer = { status: 404, body: null };
    h.advanceTime(61_000); await h.tick();
    expect(acked()).toBe(false);
    expect(getMeta(h.db, "proto:team-a")).toBe("1");
    expect(JSON.parse(getMeta(h.db, usageAckKey(PEER))!)).toEqual({ ack: false, at: h.d.now() });
  });
});

describe("[验收线 2][验收线 3] lendUsageFor：off 不带；observe 不带、记观察；on 且已声明才带", () => {
  const row = { orderId: "o1", peer: PEER, sessionId: "thr-1", payload: null };

  test("off：不查库、不带、不记", () => {
    const db = openLendJournal(":memory:");
    writeUsageAck(db, PEER, 4, 1_000);
    const r = inject("off");
    expect(lendUsageFor(db, row, { now: () => 1_000 })).toEqual({});
    expect(r.reads).toEqual([]);
    expect(usageObserved(db, "o1")).toBeNull();
  });

  test("observe：照常算（只查这一单的会话），不带；journal 记一条这一单本会带什么，同单覆盖", () => {
    const db = openLendJournal(":memory:");
    const r = inject("observe");
    expect(lendUsageFor(db, row, { now: () => 1_000 })).toEqual({});
    expect(r.reads).toEqual(["thr-1"]);
    expect(usageObserved(db, "o1")).toEqual({ at: 1_000, peer: PEER, sessionId: "thr-1", acked: false, usage: USAGE });
    writeUsageAck(db, PEER, 4, 2_000);
    expect(lendUsageFor(db, row, { now: () => 2_000 })).toEqual({});
    expect(usageObserved(db, "o1")).toMatchObject({ at: 2_000, acked: true });
    expect(db.query("SELECT COUNT(*) AS n FROM lend_meta WHERE key LIKE 'usageObserved:%'").get()).toEqual({ n: 1 });
    expect(r.lines.length).toBe(2);
  });

  test("on：借入方没声明不带；声明了带；查不到会话不带（不写 0）；没有会话不查", () => {
    const db = openLendJournal(":memory:");
    inject("on");
    expect(lendUsageFor(db, row, { now: () => 1_000 })).toEqual({});
    writeUsageAck(db, PEER, 4, 1_000);
    expect(lendUsageFor(db, row, { now: () => 1_000 })).toEqual({ usage: USAGE });
    inject("on", null);
    expect(lendUsageFor(db, row, { now: () => 1_000 })).toEqual({});
    const r = inject("on");
    expect(lendUsageFor(db, { ...row, sessionId: null }, { now: () => 1_000 })).toEqual({});
    expect(r.reads).toEqual([]);
  });

  test("已落 payload（result_pending 重交）：原样沿用里面那份，不重查", () => {
    const db = openLendJournal(":memory:");
    const r = inject("on");
    expect(lendUsageFor(db, { ...row, payload: { usage: USAGE } })).toEqual({ usage: USAGE });
    expect(lendUsageFor(db, { ...row, payload: { v: 1 } })).toEqual({});
    expect(r.reads).toEqual([]);
  });

  test("观察随出借单的保留期删：单还在跑的留着；结束满 24 小时、或 journal 没这一单了就删", () => {
    const h = harness();
    const now = h.d.now();
    recordAsked(h.db, { orderId: "o1", peer: PEER, fp: FP, family: "codex", preview: polled("o1") }, now);
    for (const id of ["o1", "gone"]) h.db.run("INSERT INTO lend_meta (key, value) VALUES (?, '{}')", [`usageObserved:${id}`]);
    expect(pruneUsageObserved(h.db, now + OBSERVED_KEEP_MS * 10)).toBe(1); // o1 还是 asked（在跑）：留着
    expect(getMeta(h.db, "usageObserved:o1")).toBe("{}");
    advance(h.db, "o1", "asked", "declined", {}, now);
    expect(pruneUsageObserved(h.db, now + OBSERVED_KEEP_MS)).toBe(0);
    expect(pruneUsageObserved(h.db, now + OBSERVED_KEEP_MS + 1)).toBe(1);
    expect(getMeta(h.db, "usageObserved:o1")).toBeNull();
  });
});

describe("[验收线 4] 只算这一单的 worker 会话", () => {
  const path = join(tmp, "usage.sqlite");
  const u = openUsageDb(path);
  const turn = u.prepare("INSERT INTO turns (turn_id, agent, session_id, sidechain, started_at, kind, trigger, runtime, attr_task) VALUES (?, ?, ?, ?, ?, 'user', 'user', ?, ?)");
  const call = u.prepare(`INSERT INTO calls (key, turn_id, ts, day, model, input, cache_creation, cache_read, output, reasoning)
    VALUES (?, ?, ?, '2026-10-13', 'm', ?, ?, ?, ?, ?)`);
  // 这一单：主线两轮 + sidechain 一轮（同一个会话）
  turn.run("t1", "lend-w1", "sess-order", 0, 1_000, "claude", "T9"); call.run("c1", "t1", 1_000, 10, 1, 100, 5, 0); call.run("c2", "t1", 1_200, 20, 2, 200, 6, 0);
  turn.run("t2", "lend-w1", "sess-order", 1, 1_500, "claude", "T9"); call.run("c3", "t2", 1_500, 30, 3, 300, 7, 0);
  // 同卡的另一个会话、别的卡的会话、别的 codex 会话：都不算
  turn.run("t3", "agent-pm", "sess-same-card", 0, 900, "claude", "T9"); call.run("c4", "t3", 900, 1_000, 1_000, 1_000, 1_000, 0);
  turn.run("t4", "agent-x", "sess-other-card", 0, 800, "claude", "T8"); call.run("c5", "t4", 800, 2_000, 2_000, 2_000, 2_000, 0);
  turn.run("t5", "codex-x", "sess-codex", 0, 700, "codex", "T9"); call.run("c6", "t5", 700, 4, 0, 6, 7, 8);
  u.close();

  test("汇总只含这一单的会话（主线 + sidechain），按家族一项", () => {
    expect(readSessionUsage("sess-order", path)).toEqual([
      { family: "claude", input: 60, output: 18, cacheRead: 600, cacheWrite: 6, reasoning: 0, calls: 3, firstAt: 1_000, lastAt: 1_500 },
    ]);
    expect(readSessionUsage("sess-codex", path)).toEqual([
      { family: "codex", input: 4, output: 7, cacheRead: 6, cacheWrite: 0, reasoning: 8, calls: 1, firstAt: 700, lastAt: 700 },
    ]);
  });

  test("查不到会话 / 库不在：null（调用方就不带，不写 0）", () => {
    expect(readSessionUsage("sess-unknown", path)).toBeNull();
    expect(readSessionUsage("sess-order", join(tmp, "absent.sqlite"))).toBeNull();
    const db = openLendJournal(":memory:");
    writeUsageAck(db, PEER, 4, 1_000);
    useUsageReportDeps({ mode: () => "on", read: (sid) => readSessionUsage(sid, path) });
    expect(lendUsageFor(db, { orderId: "o1", peer: PEER, sessionId: "sess-unknown", payload: null }, { now: () => 1_000 })).toEqual({});
    expect(lendUsageFor(db, { orderId: "o1", peer: PEER, sessionId: "sess-order", payload: null }, { now: () => 1_000 }).usage).toHaveLength(1);
  });
});

describe("[验收线 2][验收线 3] 接线：审查结论（lend-submit）与写单交付（lend-drive）", () => {
  /** 握手一次（A 应答 proto），走到 started，worker 交结论；返回落进 journal 的正文 */
  async function reviewed(proto: number, mode: RecoveryMode): Promise<Record<string, unknown>> {
    const h = harness();
    writeUsageAck(h.db, PEER, proto, h.d.now());
    const r = inject(mode);
    await toStarted(h);
    expect(commitLendResult(h.db, getOrder(h.db, "o1")!, INPUT, h.d.now())).toMatchObject({ ok: true, duplicate: false });
    if (mode !== "off") expect(r.reads).toEqual(["thr-1"]);
    return getOrder(h.db, "o1")!.payload!;
  }

  test("缺省（不注入）= off：正文与改前同形", async () => {
    const h = harness();
    writeUsageAck(h.db, PEER, 4, h.d.now());
    await toStarted(h);
    commitLendResult(h.db, getOrder(h.db, "o1")!, INPUT, h.d.now());
    expect(Object.keys(getOrder(h.db, "o1")!.payload!)).toEqual(["v", "orderId", "gen", "verdict", "report", "session"]);
  });

  test("on + 借入方 proto 4：带 usage；on + proto 3：不带；observe：不带", async () => {
    expect((await reviewed(4, "on")).usage).toEqual(USAGE);
    expect(await reviewed(3, "on")).not.toHaveProperty("usage");
    expect(await reviewed(4, "observe")).not.toHaveProperty("usage");
    expect(await reviewed(4, "off")).not.toHaveProperty("usage");
  });

  test("同一份结论重交：用量变了也沿用已存的那份，仍是幂等成功", async () => {
    const h = harness();
    writeUsageAck(h.db, PEER, 4, h.d.now());
    inject("on");
    await toStarted(h);
    const first = commitLendResult(h.db, getOrder(h.db, "o1")!, INPUT, h.d.now());
    inject("on", [{ ...USAGE[0], calls: 99 }]);
    expect(first.ok).toBe(true);
    expect(commitLendResult(h.db, getOrder(h.db, "o1")!, INPUT, h.d.now())).toEqual({ ok: true, duplicate: true, sha: first.ok ? first.sha : "" });
    expect(getOrder(h.db, "o1")!.payload!.usage).toEqual(USAGE);
  });

  /** 写单：在 journal 里造到 worker 已交活，tick 一次由 publishWork 拼交付正文 */
  async function wrote(proto: number, mode: RecoveryMode): Promise<Record<string, unknown>> {
    const h = harness({ entry: { roles: ["review", "write"] } });
    const now = h.d.now();
    writeUsageAck(h.db, PEER, proto, now);
    inject(mode);
    recordAsked(h.db, { orderId: "w1", peer: PEER, fp: FP, family: "codex", preview: { ...polled("w1"), step: "write", pr: null } }, now);
    advance(h.db, "w1", "asked", "claimed", { wire: { order: { ...wire("w1"), node: "write", step: "write", pr: null }, text: TEXT,
      write: { branch: "lend/T93-x", base: "main" } }, day: localDay(now), leaseGen: 1, leaseUntil: now + 600_000, lastBeatAt: now }, now);
    advance(h.db, "w1", "claimed", "cloned", { dir: "/lend/work/w1" }, now);
    h.registry.set("lend-w1", { sessionId: "s-w1", cwd: "/lend/work/w1" });
    advance(h.db, "w1", "cloned", "started", { agent: "lend-w1", sessionId: "s-w1", startedAt: now, submit: "sent", notices: { start: now } }, now);
    advance(h.db, "w1", "started", "result_pending", { work: { head: "c".repeat(40), summary: "实现了 x", selfCheck: "逐条对了" } }, now);
    h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [], pollAfterMs: 30_000 } });
    await h.tick();
    const payload = getOrder(h.db, "w1")!.payload!;
    expect(payload).toMatchObject({ deliver: { orderId: "w1" }, session: { id: "s-w1" } });
    return payload;
  }

  test("写单交付：on + proto 4 带；没声明 / off / observe 不带", async () => {
    expect((await wrote(4, "on")).usage).toEqual(USAGE);
    expect(await wrote(3, "on")).not.toHaveProperty("usage");
    expect(await wrote(4, "observe")).not.toHaveProperty("usage");
    expect(await wrote(4, "off")).not.toHaveProperty("usage");
  });
});
