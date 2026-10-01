/**
 * i28-W6 A 侧远端行（lib/lend-workers-view.ts）：临时台账里经 `ledger lend-offer / lend-claim` 挂单领单，再用 W2 的 beatLend
 * 按 lend-wire-v2 的 BeatRequest 灌假心跳（真发送方是 W3）。覆盖 state 各分支、60 秒边界、终态不出现、老库返回空、名字规则。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { workerName } from "../src/lib/lend-drive.js";
import type { BeatOrder } from "../src/lib/lend-wire-v2.js";
import { beatLend } from "../src/lib/ledger-lend-peers.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { BEAT_LIVE_MS, isLendWorkerName, lendWorkerRows } from "../src/lib/lend-workers-view.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const H = "a".repeat(40);
const REPO = "shawnlu96/claudestra";
const dir = mkdtempSync(join(tmpdir(), "lend-workers-view-"));
let db: Database;
let now: number;
const borrow: BorrowEntry[] = [{ peer: "mate", projects: [P, "other-proj"], roles: ["review", "write"], maxOpen: 5 }];

const deps = (actor: string) => ({
  db, actor, projectIds: [P, "other-proj"], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => now,
  lend: { borrow: async () => borrow, notifyPm: async () => {} },
});
const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor) as never) as Promise<Record<string, any>>;

function card(id: string, project = P): void {
  const spec = join(dir, `${id}.md`);
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  createTask(db, { actor: "owner", now }, { project, id, title: id, kind: "code", spec, agent: "agent-dev" } as never);
  db.run(`UPDATE tasks SET stage = 'review', headSHA = '${H}', round = 1 WHERE id = '${id}'`);
}

/** 挂一单给 mate 并让它领下（代数 1），返回 orderId */
async function held(id: string, worker: string, project = P): Promise<string> {
  card(id, project);
  const { orderId } = await run(["lend-offer", id, "--peer", "mate", "--repo", REPO, "--pr", "12"]);
  expect((await run(["lend-claim", "--", "mate", JSON.stringify({ v: 1, orderId, worker })], "owner")).ok).toBe(true);
  return orderId;
}

const line = (orderId: string, over: Partial<BeatOrder> = {}): BeatOrder =>
  ({ orderId, gen: 1, phase: "working", lastActivityAt: now - 5_000, excerpt: "跑测试中", ended: null, ...over });
const beat = (orders: BeatOrder[]) => beatLend(db, { actor: "owner", now }, "mate", { v: 1, orders }, new Map());

beforeEach(() => {
  db = openLedger(":memory:");
  now = 1_000_000;
  for (const p of [P, "other-proj"]) setMeta(db, { actor: "owner", now }, { project: p, key: "pms", value: ["agent-pm"] });
});
afterEach(() => closeLedger(":memory:"));

describe("isLendWorkerName", () => {
  test("和 lend-drive.ts workerName 同一规则：带不带 agent- 前缀都认", () => {
    for (const id of ["o1", "t68:s1:r0:review:a0", "x".repeat(150)]) {
      const n = workerName(id);
      expect(isLendWorkerName(n)).toBe(true);
      expect(isLendWorkerName(n.replace(/^agent-/, ""))).toBe(true);
    }
  });
  test("别的名字一律不认", () => {
    for (const n of ["agent-claudestra", "lend-0123", "lend-0123456789a", "agent-lend-ABCDEF0123", "agent-agent-lend-0123456789", "lend-0123456789@mate", " lend-0123456789", ""]) {
      expect(isLendWorkerName(n)).toBe(false);
    }
  });
});

describe("lendWorkerRows", () => {
  test("刚 beat 过 = running，行和本地行同形（显示名、团队 id、角色、阶段、摘要）", async () => {
    const o = await held("T1", "agent-lend-0123456789");
    expect(beat([line(o)]).orders[0]!.verdict).toBe("ok");
    const [r] = lendWorkerRows(db, now);
    expect(r).toMatchObject({
      name: "lend-0123456789@mate", id: "peer:mate/lend-0123456789", peer: "mate", worker: "lend-0123456789", orderId: o, taskId: "T1", project: P,
      step: "review", role: "审查员", phase: "working", beatAt: now, lastActivityAt: now - 5_000, excerpt: "跑测试中", state: "running",
    });
  });

  test("60 秒边界：正好 60 秒仍 running，多 1 毫秒就 silent", async () => {
    const o = await held("T1", "agent-lend-0123456789");
    beat([line(o)]);
    expect(lendWorkerRows(db, now + BEAT_LIVE_MS)[0]!.state).toBe("running");
    expect(lendWorkerRows(db, now + BEAT_LIVE_MS + 1)[0]!.state).toBe("silent");
  });

  test("beat 的代数不是当前租约代数 = silent（重领之后旧 beat 不算）", async () => {
    const o = await held("T1", "agent-lend-0123456789");
    beat([line(o)]);
    db.run("UPDATE lend_orders SET leaseGen = 2 WHERE orderId = ?", [o]);
    expect(lendWorkerRows(db, now)[0]!.state).toBe("silent");
  });

  test("领了但从没 beat（proto 1）= no_beat，不是 running", async () => {
    await held("T1", "agent-lend-0123456789");
    expect(lendWorkerRows(db, now)[0]).toMatchObject({ state: "no_beat", phase: null, beatAt: null, excerpt: null });
  });

  test("unknown（停给 PM）照样出现，状态 unknown", async () => {
    const o = await held("T1", "agent-lend-0123456789");
    beat([line(o)]);
    db.run("UPDATE lend_orders SET status = 'unknown' WHERE orderId = ?", [o]);
    expect(lendWorkerRows(db, now)[0]!.state).toBe("unknown");
  });

  test("done / cancelled / released / pooled 不出现", async () => {
    const o = await held("T1", "agent-lend-0123456789");
    beat([line(o)]);
    for (const s of ["done", "cancelled", "released", "pooled"]) {
      db.run("UPDATE lend_orders SET status = ? WHERE orderId = ?", [s, o]);
      expect(lendWorkerRows(db, now)).toEqual([]);
    }
  });

  test("按项目过滤；不带项目列全部", async () => {
    await held("T1", "agent-lend-0123456789");
    await held("T2", "agent-lend-abcdef0123", "other-proj");
    expect(lendWorkerRows(db, now).map((r) => r.taskId)).toEqual(["T1", "T2"]);
    expect(lendWorkerRows(db, now, "other-proj").map((r) => r.name)).toEqual(["lend-abcdef0123@mate"]);
    expect(lendWorkerRows(db, now, "nope")).toEqual([]);
  });

  test("没有 lend 表或没有 beat 列的老库返回空", async () => {
    await held("T1", "agent-lend-0123456789");
    db.run("ALTER TABLE lend_orders DROP COLUMN beat");
    expect(lendWorkerRows(db, now)).toEqual([]);
    db.run("DROP TABLE lend_orders");
    expect(lendWorkerRows(db, now)).toEqual([]);
  });
});
