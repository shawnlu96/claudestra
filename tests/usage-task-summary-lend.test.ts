/**
 * LENDUSAGE1 借入方 A 这一半：带 usage 的交回原样记进台账（note，data.lendUsage），同一单重交不重复计；
 * usage-task-summary.ts 把它计入按家族合计、单列「其中对方回传」，没带的仍算「用量对方未回传」单数；估算占本周额度只用本机数。
 * 走真的 `ledger lend-write`（本机内存台账，对方是合成的 peer「mate」）与 writeLendDeliver（修复单夹具），同 tests/role-model-lend.test.ts。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fourRoundFix } from "./fix-strategy-helpers.js";
import { remoteProbe, resultDeps } from "./fix-strategy-remote-helpers.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { remoteOrder } from "../src/lib/fix-strategy-remote-order.js";
import { claimLend } from "../src/lib/ledger-lend.js";
import { writeLendDeliver } from "../src/lib/ledger-lend-result.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { lendReportedUsage, reportedOf, type LendReported } from "../src/lib/lend-usage-report.js";
import type { DeliverRequest, LendUsage } from "../src/lib/lend-wire.js";
import { useRoleModelPort } from "../src/lib/role-model-settings-local.js";
import { defaultRoleModels } from "../src/lib/role-model-settings.js";
import type { FamilyPart, TaskUsageFacts } from "../src/lib/usage-query.js";
import { summarizeTaskUsage } from "../src/lib/usage-task-summary.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const H = "a".repeat(40);
const ORDER = "lend:T9:s1:r1:a0";
const WORKER = "agent-lend-0123456789";
const dir = mkdtempSync(join(tmpdir(), "usage-summary-lend-"));
const spec = join(dir, "T9.md");
writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
let db: Database;
const now = 1_000_000;

const deps = (actor: string) => ({
  db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => now,
  lend: {
    borrow: async () => [{ peer: "mate", projects: [P], roles: ["review" as const], maxOpen: 2 }], notifyPm: async () => {},
    result: { reportDir: () => dir, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: () => ({ key: "KEY", sig: "SIG" }), peerFp: async () => null },
  },
});
const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor)) as Promise<Record<string, unknown>>;
/** 对方的一次 lend 请求；收下 = 回执正文，被拒 = wire 码 */
async function peer(ep: "claim" | "write", body: unknown): Promise<string> {
  const r = await run([`lend-${ep}`, "--", "mate", JSON.stringify(body)], "owner") as { ok?: boolean; code?: string; current?: { lend?: string }; notified?: unknown };
  if (r.ok !== true) return `refused:${String(r.current?.lend ?? r.code)}`;
  const { ok: _ok, notified: _n, ...rest } = r;
  return JSON.stringify(rest);
}

const CODEX: LendUsage = { family: "codex", input: 100, output: 200, cacheRead: 300, cacheWrite: 0, reasoning: 50, calls: 4, firstAt: 900_000, lastAt: 950_000 };
const RESULT = { v: 1, orderId: ORDER, gen: 1, verdict: { v: 1, orderId: ORDER, head: H, verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: "r.md" },
  report: "## 结论\n通过", session: { id: "sess-1", family: "codex" } };
const events = (target = "T9") => listEvents(db, { project: P, target });
const usageNotes = () => events().filter((e) => (e.data.lend as { op?: string } | undefined)?.op === "usage");

beforeEach(async () => {
  closeLedger(":memory:");
  db = openLedger(":memory:");
  useRoleModelPort({ policy: () => ({ mode: "off", manualAfterMs: null, source: "config" }), read: () => ({ status: "ok", table: defaultRoleModels() }),
    observe: () => { throw new Error("不该走到 observe"); } });
  setMeta(db, { actor: "owner", now }, { project: P, key: "pms", value: ["agent-pm"] });
  createTask(db, { actor: "owner", now }, { project: P, id: "T9", title: "T9", kind: "code", spec });
  db.run(`UPDATE tasks SET stage = 'review', headSHA = '${H}', round = 1 WHERE id = 'T9'`);
  await run(["lend-offer", "T9", "--peer", "mate", "--repo", "shawnlu96/claudestra", "--pr", "12"]);
  await peer("claim", { v: 1, orderId: ORDER, worker: WORKER });
});
afterEach(() => { useRoleModelPort(); closeLedger(":memory:"); });

describe("[验收线 5] 入账：原样记进 data.lendUsage，重交不重复计", () => {
  test("审查结论带 usage：同一事务里记一条 note；回执不多字段；读回来就是对方给的那份", async () => {
    const receipt = await peer("write", { ...RESULT, usage: [CODEX] });
    expect(receipt).not.toMatch(/^refused/);
    expect(Object.keys((JSON.parse(receipt) as { receipt: object }).receipt)).toEqual(["orderId", "sha256", "eventSeq", "taskId", "key", "sig"]);
    const notes = usageNotes();
    expect(notes.length).toBe(1);
    expect(notes[0].data).toMatchObject({ lend: { orderId: ORDER, peer: "mate", gen: 1, family: "codex", op: "usage" }, lendUsage: [CODEX] });
    expect(lendReportedUsage(db, "T9")).toEqual([{ orderId: ORDER, family: "codex", usage: [CODEX] }]);
  });

  test("同一单号同一 gen 原样重交：回同一张回执，不记第二条；换一份（用量不同）拒 conflict，也不记", async () => {
    const body = { ...RESULT, usage: [CODEX] };
    const first = await peer("write", body);
    expect(await peer("write", body)).toBe(first);
    expect(await peer("write", { ...RESULT, usage: [{ ...CODEX, calls: 5 }] })).toBe("refused:conflict");
    expect(usageNotes().length).toBe(1);
    expect(lendReportedUsage(db, "T9").length).toBe(1);
  });

  test("不带 usage：不记 note，入账与改前一样；带坏 usage：整条 invalid，卡上什么都不留", async () => {
    expect(await peer("write", { ...RESULT, usage: [{ ...CODEX, input: -1 }] })).toBe("refused:invalid");
    expect(events().filter((e) => e.kind === "review").length).toBe(0);
    expect(await peer("write", RESULT)).not.toMatch(/^refused/);
    expect(usageNotes()).toEqual([]);
    expect(lendReportedUsage(db, "T9")).toEqual([]);
  });

  test("修复单交付（writeLendDeliver）带 usage：同样记一条；重交走旧回执不多记", async () => {
    const f = await fourRoundFix();
    try {
      const p = remoteProbe(f), intent = p.plan(); p.deps.localFamilyWait = () => "本机不接codex";
      await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps); await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
      const o = remoteOrder(f.db, intent.id)!;
      claimLend(f.db, f.at("owner"), "Peer", { v: 1, orderId: o.orderId, worker: WORKER }, () => p.context.borrow[0]);
      const head = "5".repeat(40), req = { v: 1, orderId: o.orderId, gen: 1, branch: "feat/T1", pr: 7, session: { id: "peer-session", family: "codex" },
        deliver: { v: 1, orderId: o.orderId, head, evidence: "report.md", summary: "复现测试：remote-race，先红后绿", selfCheck: "先红后绿" }, usage: [CODEX] } as DeliverRequest;
      const d = { ...resultDeps, peerFp: async () => "abcd-bbbb-cccc-dddd", remoteHead: async () => ({ ok: true as const, head }) };
      const r1 = await writeLendDeliver(f.db, f.at("owner"), "Peer", req, "body", d);
      expect(await writeLendDeliver(f.db, f.at("owner"), "Peer", req, "body", d)).toEqual(r1);
      expect(f.task().stage).toBe("review");
      expect(lendReportedUsage(f.db, f.task().id)).toEqual([{ orderId: o.orderId, family: "codex", usage: [CODEX] }]);
    } finally { f.close(); }
  });

  test("台账里格式不对的旧记录不拖垮汇总：跳过", () => {
    expect(reportedOf({ lend: { op: "usage", orderId: "x", family: "codex" }, lendUsage: [{ ...CODEX, input: -1 }] })).toBeNull();
    expect(reportedOf({ lend: { op: "actual", orderId: "x", family: "codex" }, lendUsage: [CODEX] })).toBeNull();
    expect(reportedOf(null)).toBeNull();
  });
});

const part = (family: string, n: number, firstAt: number, lastAt: number): FamilyPart =>
  ({ family, input: n, cacheCreation: n, cacheRead: n, output: n, reasoning: 0, totalTokens: 4 * n, calls: n, firstAt, lastAt });
const facts = (over: Partial<TaskUsageFacts> = {}): TaskUsageFacts =>
  ({ detail: [], archive: [], sessions: {}, week: {}, detailFrom: null, unarchivedBefore: null, ...over });
const WEEK = 7 * 86_400_000;

describe("[验收线 5] 汇总：计入按家族合计、单列其中对方回传、没带的仍算未回传单数", () => {
  const reported: LendReported[] = [{ orderId: "o1", family: "codex", usage: [CODEX] }];

  test("对方回传计入合计（含 reasoning，同本机算法），peerReported 单列；本机明细不变", () => {
    const s = summarizeTaskUsage(facts({ detail: [part("codex", 10, 1_000_000, 2_000_000)], sessions: { codex: 2 } }), { codex: { done: 3 } }, {}, reported);
    expect(s.families.codex).toMatchObject({ totalTokens: 40 + 650, calls: 14, input: 110, cacheCreation: 10, reasoning: 50, sessions: 3,
      firstAt: 900_000, lastAt: 2_000_000 });
    expect(s.families.codex!.detail.totalTokens).toBe(40);
    expect(s.families.codex!.peerReported).toEqual({ input: 100, cacheCreation: 0, cacheRead: 300, output: 200, reasoning: 50, totalTokens: 650, calls: 4, orders: 1 });
    expect(s).toMatchObject({ totalTokens: 690, calls: 14 });
    expect(s.lent.codex).toEqual({ orders: 3, byStatus: { done: 3 }, tokensReported: true, note: "用量对方未回传", reportedOrders: 1, unreportedOrders: 2 });
  });

  test("只有对方回传、本机没有这个家族的明细：照样出家族；全部回传时未回传单数为 0", () => {
    const s = summarizeTaskUsage(facts(), { codex: { done: 1 } }, {}, reported);
    expect(s.families.codex).toMatchObject({ totalTokens: 650, detail: { totalTokens: 0 }, archived: null, peerReported: { orders: 1 } });
    expect(s.lent.codex).toMatchObject({ tokensReported: true, reportedOrders: 1, unreportedOrders: 0, note: "用量对方都已回传" });
  });

  test("没有回传：与改前同形（peerReported null，lent 没有新键）", () => {
    const s = summarizeTaskUsage(facts({ detail: [part("claude", 5, 1, 2)] }), { codex: { done: 2 } }, {});
    expect(s.families.claude!.peerReported).toBeNull();
    expect(s.lent).toEqual({ codex: { orders: 2, byStatus: { done: 2 }, tokensReported: false, note: "用量对方未回传" } });
  });

  test("估算占本周额度的分子分母都只有本机数：带不带回传结果一样", () => {
    const quota = { codex: { weekUsedPct: 40, resetAt: 10 * WEEK } };
    const f = facts({ detail: [part("codex", 10, 1, 2)], week: { codex: { task: 250, machine: 1000 } } });
    const without = summarizeTaskUsage(f, { codex: { done: 1 } }, quota);
    const withPeer = summarizeTaskUsage(f, { codex: { done: 1 } }, quota, reported);
    expect(withPeer.weekEstimate).toEqual(without.weekEstimate);
    expect(withPeer.weekEstimate.codex).toMatchObject({ estimatePct: 10, taskWeekTokens: 250, machineWeekTokens: 1000 });
  });

  test("端到端：台账里的回传经 lendReportedUsage 进汇总", async () => {
    await peer("write", { ...RESULT, usage: [CODEX] });
    const s = summarizeTaskUsage(facts(), { codex: { done: 1 } }, {}, lendReportedUsage(db, "T9"));
    expect(s.families.codex!.peerReported).toMatchObject({ totalTokens: 650, orders: 1 });
    expect(s.lent.codex).toMatchObject({ reportedOrders: 1, unreportedOrders: 0 });
  });
});
