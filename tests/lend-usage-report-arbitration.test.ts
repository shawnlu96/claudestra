/**
 * LENDUSAGE1 第 1 轮审查修复：仲裁交回的用量（B 组装 lend-arbiter-submit.ts、A 入账 ledger-lend-result.ts convergenceWithUsage），
 * 与观察记录随 lend-work-retention.ts sweepStoppedWork 每轮清理。
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arbitrationFixture, resultDeps, verdictRequest } from "./fix-strategy-remote-helpers.js";
import { arbiterStep } from "../src/lib/review-arbiter-runtime.js";
import { remoteOrder } from "../src/lib/fix-strategy-remote-order.js";
import { claimLend } from "../src/lib/ledger-lend.js";
import { writeLendResult } from "../src/lib/ledger-lend-result.js";
import { parseLendRequest, type ResultRequest } from "../src/lib/lend-wire.js";
import { advance, getMeta, getOrder, openLendJournal, recordAsked, setMeta } from "../src/lib/lend-journal.js";
import { orderWireOf } from "../src/lib/order-wire.js";
import { submitLendResult } from "../src/lib/lend-submit.js";
import { sweepStoppedWork, STOPPED_RETENTION_MS as DAY } from "../src/lib/lend-work-retention.js";
import { lendReportedUsage, pruneUsageObserved, useUsageReportDeps, writeUsageAck, type LendUsage } from "../src/lib/lend-usage-report.js";

const USAGE: LendUsage[] = [{ family: "codex", input: 10, output: 20, cacheRead: 30, cacheWrite: 0, reasoning: 5, calls: 2, firstAt: 100, lastAt: 200 }];

afterEach(() => useUsageReportDeps(null));

test("[验收线 5] 仲裁交回带合法 usage：首交入账一条，同单同 gen 重交回旧回执、不重复计", async () => {
  const { f, p, intent } = await arbitrationFixture();
  try {
    await arbiterStep(f.db, f.at("scheduler"), intent.id, 2, p.deps);
    const o = remoteOrder(f.db, intent.id)!;
    claimLend(f.db, f.at("peer:Peer"), "Peer", { v: 1, orderId: o.orderId, worker: "new-arbiter" }, () => p.context.borrow[0]);
    const parsed = parseLendRequest("result", { ...verdictRequest(remoteOrder(f.db, intent.id)!), usage: USAGE });
    expect(parsed.ok).toBe(true);
    const req = (parsed as { value: ResultRequest }).value;
    const first = writeLendResult(f.db, f.at("peer:Peer"), "Peer", req, "same", resultDeps);
    expect(writeLendResult(f.db, f.at("peer:Peer"), "Peer", req, "same", resultDeps)).toEqual(first);
    expect(lendReportedUsage(f.db, o.taskId)).toEqual([{ orderId: o.orderId, family: o.family, usage: USAGE }]);
    const notes = f.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'note' AND json_extract(data, '$.lend.op') = 'usage'").get() as { n: number };
    expect(notes.n).toBe(1);
  } finally { f.close(); }
});

test("[验收线 5] 仲裁交回被拒时 usage 不入账（同一外层事务回滚）", async () => {
  const { f, p, intent } = await arbitrationFixture();
  try {
    await arbiterStep(f.db, f.at("scheduler"), intent.id, 2, p.deps);
    const o = remoteOrder(f.db, intent.id)!;
    claimLend(f.db, f.at("peer:Peer"), "Peer", { v: 1, orderId: o.orderId, worker: "new-arbiter" }, () => p.context.borrow[0]);
    const req = { ...verdictRequest(remoteOrder(f.db, intent.id)!), usage: USAGE, report: "x" };
    expect(() => writeLendResult(f.db, f.at("peer:Peer"), "Peer", req, "sha", { ...resultDeps, writeReport: () => { throw new Error("disk"); } })).toThrow();
    expect(lendReportedUsage(f.db, o.taskId)).toEqual([]);
  } finally { f.close(); }
});

function arbiterOrder() {
  const db = openLendJournal(":memory:"), now = Date.now(), orderId = "lend:T1:cv:100", head = "1".repeat(40);
  const order = { ...orderWireOf({ taskId: "T1", specRev: 1, round: 3, head, node: "arbitration", step: "review", dedupKey: orderId,
    inputs: [], outputs: [], acceptance: [], writeBack: "arbiter submit" }),
    convergence: { kind: "arbitration", intentId: "arbiter:d1", disputeSeq: 1, findingId: "finding", excludedSessions: ["author-session"] } };
  recordAsked(db, { orderId, peer: "A", fp: null, family: "codex", preview: {} }, now);
  advance(db, orderId, "asked", "claimed", { leaseGen: 1, leaseUntil: now + 60_000, wire: { order, text: "arbitration" } }, now);
  advance(db, orderId, "claimed", "cloned", { dir: "/isolated/arbitration" }, now);
  advance(db, orderId, "cloned", "started", { agent: "arbiter-worker", sessionId: "fresh-session" }, now);
  const deps = { cwd: "/isolated/arbitration", pid: 10, agentSession: () => "fresh-session", panePid: async () => 2, ancestors: async () => [2] };
  const input = { verdict: "overturned", findings: [], report: "Probe lacks an assertion; finding is overturned." };
  return { db, now, orderId, deps, input };
}

test("[验收线 2] B 的仲裁交回：on 且 A 声明 proto 4 才带这一单会话的 usage，重交逐字节幂等", async () => {
  const { db, now, orderId, deps, input } = arbiterOrder();
  try {
    const reads: string[] = [];
    useUsageReportDeps({ mode: () => "on", read: (sid) => (reads.push(sid), USAGE) });
    writeUsageAck(db, "A", 4, now);
    const r = await submitLendResult(db, orderId, input, deps, now);
    expect(r).toMatchObject({ ok: true, duplicate: false });
    expect(getOrder(db, orderId)?.payload?.usage).toEqual(USAGE);
    expect(reads).toEqual(["fresh-session"]);
    useUsageReportDeps({ mode: () => "on", read: () => [{ ...USAGE[0], calls: 9 }] }); // worker 还在跑、用量变了
    expect(await submitLendResult(db, orderId, input, deps, now)).toEqual({ ok: true, duplicate: true, sha: (r as { sha: string }).sha });
  } finally { db.close(); }
});

test("[验收线 2] B 的仲裁交回：A 没声明时 on 也不带", async () => {
  const { db, now, orderId, deps, input } = arbiterOrder();
  try {
    useUsageReportDeps({ mode: () => "on", read: () => USAGE });
    writeUsageAck(db, "A", 3, now);
    expect(await submitLendResult(db, orderId, input, deps, now)).toMatchObject({ ok: true });
    expect(getOrder(db, orderId)?.payload).not.toHaveProperty("usage");
  } finally { db.close(); }
});

test("观察记录随 sweepStoppedWork 每轮清：stopped 满 24 小时删，在跑的留；清理出错只记日志、不打断", () => {
  const home = mkdtempSync(join(tmpdir(), "usage-retention-"));
  const db = openLendJournal(join(home, "journal.sqlite"));
  try {
    const now = 10 * DAY;
    for (const [id, state] of [["old", "stopped"], ["live", "started"]] as const) {
      recordAsked(db, { orderId: id, peer: "test", fp: null, family: "codex", preview: {} }, now - 100);
      db.query("UPDATE lend_orders SET state = ?, updatedAt = ? WHERE orderId = ?").run(state, now, id);
      setMeta(db, `usageObserved:${id}`, "{}");
    }
    const lines: string[] = [];
    sweepStoppedWork(db, { root: home, now: now + 2 * DAY, log: (l) => lines.push(l) });
    expect(getMeta(db, "usageObserved:old")).toBeNull();
    expect(getMeta(db, "usageObserved:live")).toBe("{}");
    const logged: string[] = [];
    db.close();
    expect(pruneUsageObserved(db, now, (l) => logged.push(l))).toBe(0);
    expect(logged.length).toBe(1);
  } finally { try { db.close(); } catch { /* closed */ } rmSync(home, { recursive: true, force: true }); }
});
