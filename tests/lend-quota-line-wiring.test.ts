/**
 * QLINE1 真实入口组合：出借循环（lend-loop → lend-drive claimProblem / lend-hello helloBody，tests/lend-harness.ts 的假 A、手拨时钟）
 * 读的是测试临时 statePath 里的额度线配置与事实文件（生产路径同一份 helper），再把出借方真发出的 hello 交给借入方的生产解析器 + recordHello
 * + 生产派单规划（poolStartFacts / placeFor）。覆盖：停线不领新单、提醒区间按批准缩法减半（单槽 / 忙槽）、末刻改配置、在跑单与 WIP 保持、
 * busy 照实、跨家族独立、unknown 不收窄、旧快照重读不解除停接、原 QP1 暂停不被本规则恢复、重置后自动恢复、hello 字段形状不变（旧 peer 兼容）。
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InventoryQuota } from "../src/lib/ai-quota.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { noteClaudeReadiness } from "../src/lib/lend-claude-worker-capacity.js";
import { getOrder } from "../src/lib/lend-journal.js";
import { pauseForQuota } from "../src/lib/lend-health.js";
import { QUOTA_LINES_PATH, saveQuotaLines } from "../src/lib/lend-quota-line-config.js";
import { QUOTA_LINE_FACTS_PATH, refreshQuotaFacts, resetQuotaFactsForTest, type QuotaFacts } from "../src/lib/lend-quota-line-facts.js";
import { parseV2Request, type HelloRequest } from "../src/lib/lend-wire-v2.js";
import { poolStartFacts } from "../src/lib/scheduler-agent-pool-start.js";
import { readSchedulerConfig } from "../src/lib/scheduler-config.js";
import { placeFor } from "../src/lib/scheduler-placement.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { harness, toStarted } from "./lend-harness.js";

const T0 = 1_000_000;
const WEEK = 7 * 86_400_000;
const dir = mkdtempSync(join(tmpdir(), "qline-wiring-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const clean = () => { for (const p of [QUOTA_LINES_PATH, QUOTA_LINE_FACTS_PATH]) rmSync(p, { force: true }); resetQuotaFactsForTest(); };
beforeEach(clean);
afterEach(() => { clean(); noteClaudeReadiness(null); });

/** 只写事实文件（= 别的进程刚读到的周额度）；resetAt 默认一周后 */
function facts(f: Partial<Record<"codex" | "claude", number>>, resetAt = T0 + WEEK, observedAt = T0): void {
  const out: QuotaFacts = {};
  for (const [k, v] of Object.entries(f)) out[k as "codex"] = { weekUsedPct: v!, resetAt, observedAt, source: "live" };
  writeFileSync(QUOTA_LINE_FACTS_PATH, JSON.stringify(out));
  resetQuotaFactsForTest();
}

describe("claim 前末刻（v1 poll → claimProblem）", () => {
  test("codex 正好 80%：poll 到单也不 claim；回到 79% 下一轮就领", async () => {
    const h = harness();
    facts({ codex: 80 });
    await h.tick();
    await h.tick();
    expect(h.ops()).toContain("poll");
    expect(h.ops()).not.toContain("claim");
    facts({ codex: 79 });
    await h.tick();
    await h.tick();
    expect(h.ops()).toContain("claim");
  });
  test("用量 75% 不变，tick 前一刻把 codex 停线改成 70：不领", async () => {
    const h = harness();
    facts({ codex: 75 });
    expect((await saveQuotaLines({ family: "codex", warnPct: 60, stopPct: 70 })).ok).toBe(true);
    await h.tick();
    await h.tick();
    expect(h.ops()).not.toContain("claim");
    expect((await saveQuotaLines({ mode: "observe" })).ok).toBe(true);
    await h.tick();
    await h.tick();
    expect(h.ops()).toContain("claim");
  });
  test("停接 85% 后再读到观测更早的旧快照 10%（live_stale）：仍不领——旧快照不能重盖较新事实", async () => {
    const h = harness();
    facts({ codex: 85 }, T0 + WEEK, T0 - 60_000);
    const stale = { status: "known", source: "live_stale", observedAt: T0 - 2 * 86_400_000, plan: null, reason: null,
      windows: [{ id: "7d", kind: "weekly", usedPct: 10, resetsAtMs: T0 + WEEK, resetPassed: false }] } satisfies InventoryQuota;
    const f = await refreshQuotaFacts(T0, { path: QUOTA_LINE_FACTS_PATH, read: async () => ({ codex: stale }) });
    expect(f.codex).toMatchObject({ weekUsedPct: 85, source: "live" });
    await h.tick();
    await h.tick();
    expect(h.ops()).not.toContain("claim");
  });
  test("另一族撞线不影响：claude 100% 时 codex 照领", async () => {
    const h = harness();
    facts({ claude: 100, codex: 10 });
    await h.tick();
    await h.tick();
    expect(h.ops()).toContain("claim");
  });
  test("读不到额度（unknown）：本规则不收窄，照原规则领", async () => {
    const h = harness();
    await h.tick();
    await h.tick();
    expect(h.ops()).toContain("claim");
  });
  test("周窗口已过的旧 95%：不当数（unknown），照领；不会因旧数一直停", async () => {
    const h = harness();
    facts({ codex: 95 }, T0 - 1);
    await h.tick();
    await h.tick();
    expect(h.ops()).toContain("claim");
  });
  test("原 QP1 Codex 撞额度暂停：用量低于线也不被本规则恢复", async () => {
    const h = harness();
    pauseForQuota(h.db, "x", { full: true, resetsAt: T0 + 3_600_000 } as never, T0, () => {});
    facts({ codex: 1 });
    await h.tick();
    await h.tick();
    expect(h.ops()).not.toContain("claim");
  });
});

describe("收回 / 过期不被恢复", () => {
  test("授权已收回：用量再低也是 grant:null、0 位，不领", async () => {
    const h = harness();
    h.lend.lend = [];
    facts({ codex: 1 });
    const sent: Record<string, unknown>[] = [];
    h.d.v2 = { boot: "boot-qline-0002", call: async (_p, op, body) => (op === "hello" && sent.push(body),
      { status: 200, body: { ok: true, v: 1, proto: 2, helloMs: 60_000, beatMs: 15_000 } }) };
    await h.tick();
    await h.tick();
    expect(h.ops()).not.toContain("claim");
    for (const b of sent) expect(b).toMatchObject({ grant: null, slots: { codex: { total: 0, busy: 0 }, claude: { total: 0, busy: 0 } } });
  });
});

describe("在跑单保持", () => {
  test("跑着的单遇到停线：不 kill、不停、照常续租，WIP 目录不删", async () => {
    const h = harness();
    await toStarted(h);
    facts({ codex: 90 });
    h.advanceTime(5 * 60_000);
    await h.tick();
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("started");
    expect(h.log.killed).toEqual([]);
    expect(h.log.removed).toEqual([]);
    expect(h.calls.filter((c) => c.op === "lease").every((c) => c.body.action === "renew")).toBe(true);
  });
});

describe("hello → 借入方生产解析 + 派单规划", () => {
  const BORROW: BorrowEntry = { peer: "team-a", projects: ["alpha"], roles: ["review", "write"], maxOpen: 10 };
  let ledger: Database;
  let ledgerPath: string;
  let schedPath: string;
  beforeEach(() => {
    const d = mkdtempSync(join(dir, "case-"));
    ledgerPath = join(d, "ledger.db");
    schedPath = join(d, "scheduler.json");
    ledger = openLedger(ledgerPath);
    writeFileSync(schedPath, JSON.stringify({ enabled: true, projects: {
      alpha: { agents: { claude: 2, codex: 2 }, requiredChecks: ["ci"], repoDir: d, remote: { mode: "balance", repo: "shawnlu96/claudestra" } } } }));
  });
  afterEach(() => closeLedger(ledgerPath));

  async function lenderHello(pct: Partial<Record<"codex" | "claude", number>>, busyCodex = false) {
    const h = harness({ entry: { families: { codex: 2, claude: 2 }, roles: ["review", "write"] } });
    noteClaudeReadiness({ ready: true, reason: null, at: Date.now() });
    if (busyCodex) await toStarted(h);
    facts(pct, (busyCodex ? T0 + 600_000 : T0) + WEEK, T0);
    const sent: Record<string, unknown>[] = [];
    h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [], pollAfterMs: 30_000 } });
    h.d.v2 = { boot: "boot-qline-0001", call: async (_peer, op, body) => {
      if (op === "hello") sent.push(body);
      return { status: 200, body: op === "hello" ? { ok: true, v: 1, proto: 2, helloMs: 60_000, beatMs: 15_000 }
        : { ok: true, v: 1, orders: ((body.orders ?? []) as { orderId: string; gen: number }[])
          .map((o) => ({ orderId: o.orderId, verdict: "ok", lease: { gen: o.gen, expiresAt: 0, ms: 600_000 } })) } };
    } };
    await h.tick();
    await h.tick();
    const body = sent.at(-1)!;
    const parsed = parseV2Request("hello", { v: 1, ...body });
    if (!parsed.ok) throw new Error(parsed.error);
    recordHello(ledger, "team-a", null, parsed.value as HelloRequest, T0);
    return { body, h };
  }
  const seats = () => poolStartFacts(ledger, "alpha", readSchedulerConfig(schedPath).projects.alpha!.remote!, [BORROW], T0).peers.find((p) => p.peer === "team-a")!.v2!.slots;
  const place = (family: "codex" | "claude") =>
    placeFor({ ...poolStartFacts(ledger, "alpha", readSchedulerConfig(schedPath).projects.alpha!.remote!, [BORROW], T0), pin: "peer:team-a" }, "write", family);

  test("codex 80%：hello 报 codex 0 位、claude 69% 照旧；规划器不往 codex 派、claude 照派；授权不撤", async () => {
    const { body } = await lenderHello({ codex: 80, claude: 69 });
    expect(body.slots).toEqual({ codex: { total: 0, busy: 0 }, claude: { total: 2, busy: 0 } });
    expect(body.grant).not.toBeNull();
    expect(seats()).toEqual({ codex: 0, claude: 2 });
    for (const f of ["codex", "claude"] as const) expect(place(f)).toMatchObject({ kind: "peer", peer: "team-a", family: "claude" });
  });
  test("claude 100%：只 claude 0 位", async () => {
    const { body } = await lenderHello({ codex: 69, claude: 100 });
    expect(body.slots).toEqual({ codex: { total: 2, busy: 0 }, claude: { total: 0, busy: 0 } });
    expect(seats()).toEqual({ codex: 2, claude: 0 });
    for (const f of ["codex", "claude"] as const) expect(place(f)).toMatchObject({ kind: "peer", peer: "team-a", family: "codex" });
  });
  test("两族都停：规划器不往这个 peer 派", async () => {
    await lenderHello({ codex: 80, claude: 80 });
    expect(seats()).toEqual({ codex: 0, claude: 0 });
    for (const f of ["codex", "claude"] as const) expect(place(f).kind).not.toBe("peer");
  });
  test("忙槽：停线时 busy 照实报（1），total 0", async () => {
    const { body, h } = await lenderHello({ codex: 85 }, true);
    expect(body.slots).toEqual({ codex: { total: 0, busy: 1 }, claude: { total: 2, busy: 0 } });
    expect(getOrder(h.db, "o1")!.state).toBe("started");
  });
  test("unknown / 69：容量不变", async () => {
    expect((await lenderHello({})).body.slots).toEqual({ codex: { total: 2, busy: 0 }, claude: { total: 2, busy: 0 } });
    clean();
    expect((await lenderHello({ codex: 69, claude: 69 })).body.slots).toEqual({ codex: { total: 2, busy: 0 }, claude: { total: 2, busy: 0 } });
    expect(seats()).toEqual({ codex: 2, claude: 2 });
  });
  test("提醒区间 70 / 79（已批缩法）：2 槽 → 1，规划器只看到 1 位；授权不撤", async () => {
    const { body } = await lenderHello({ codex: 70, claude: 79 });
    expect(body.slots).toEqual({ codex: { total: 1, busy: 0 }, claude: { total: 1, busy: 0 } });
    expect(body.grant).not.toBeNull();
    expect(seats()).toEqual({ codex: 1, claude: 1 });
    expect(place("codex")).toMatchObject({ kind: "peer", peer: "team-a" });
  });
  test("提醒区间忙槽：codex 75%、2 槽已忙 1 → total 1 busy 1，规划器不再往 codex 派、claude 照派；在跑单不动", async () => {
    const { body, h } = await lenderHello({ codex: 75 }, true);
    expect(body.slots).toEqual({ codex: { total: 1, busy: 1 }, claude: { total: 2, busy: 0 } });
    expect(seats()).toEqual({ codex: 0, claude: 2 });
    expect(place("codex")).toMatchObject({ kind: "peer", peer: "team-a", family: "claude" });
    expect(getOrder(h.db, "o1")!.state).toBe("started");
  });
  test("hello 字段形状不变（旧 peer 兼容）：没有新增顶层或 slots 字段", async () => {
    const { body } = await lenderHello({ codex: 90 });
    expect(Object.keys(body).every((k) => ["v", "boot", "grant", "paused", "proto", "quota", "seq", "slots"].includes(k))).toBe(true);
    expect(Object.keys(body.slots as object).sort()).toEqual(["claude", "codex"]);
  });
});
