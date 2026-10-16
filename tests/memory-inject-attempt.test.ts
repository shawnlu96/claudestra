/**
 * PMEMTUNE1 验收线 4（尝试样本）：本机领单入口（local_take）每次真实领取写一条 memory_inject_attempt（同一单号只一条），
 * 带结果 / 条数 / 耗时；预览不写；bridge 的只读连接上照样写；新的 memory_rank 都带 elapsedMs。
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { recordMemory, type MemoryInput } from "../src/lib/ledger-memory.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { recordMemoryAttempt } from "../src/lib/memory-inject-attempt.js";
import { orderWireFor } from "../src/lib/order-take.js";
import { reviewOrderOf } from "../src/lib/review-order.js";

const P = "demo", HEAD = "a".repeat(40);
let db: Database, dir: string, path: string;

const attempts = () => listEvents(db, { project: P }).filter((e) => e.kind === "note" && e.data.op === "memory_inject_attempt");
const take = (record = true) => {
  const r = orderWireFor(db, { task: getTask(db, "T1")!, stage: "build", step: "write", orderId: "T1:write:r0", intent: null }, record);
  if (!r.ok) throw new Error(r.error);
  return r.order;
};
const pit = (title: string): MemoryInput => ({ project: P, kind: "pitfall", title, symptom: `${title}症状`, rule: `${title}规则`, files: ["src/lib/x.ts"],
  fixable: false, via: "tool", authorRole: "reviewer", taskId: "T1", head: "abc1234", specRev: 1 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mattempt-"));
  path = join(dir, "ledger.sqlite");
  db = openLedger(path);
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  createTask(db, { actor: "owner", now: 1 }, { project: P, id: "T1", title: "批量写", kind: "code" });
  db.prepare("UPDATE tasks SET stage = 'build', headSHA = ?, extra = ? WHERE id = 'T1'").run(HEAD, JSON.stringify({ fileGlobs: ["src/lib/x*.ts"] }));
});
afterEach(() => {
  closeLedger(path);
  rmSync(dir, { recursive: true, force: true });
});

test("[验收线 4] 没有候选：真实领取记一条 empty；预览不记", () => {
  take(false);
  expect(attempts()).toEqual([]);
  take();
  expect(attempts().map((e) => e.data)).toEqual([expect.objectContaining({ channel: "local_take", order: "write", result: "empty", count: 0, orderId: "T1:write:r0" })]);
});

test("[验收线 4] 有候选：injected + 条数 + 耗时；同一单号重领不重复记；排名事件带 elapsedMs", () => {
  recordMemory(db, { actor: "pm", now: 2 }, pit("并发写要加锁"));
  take();
  take();
  expect(attempts()).toHaveLength(1);
  expect(attempts()[0]!.data).toMatchObject({ result: "injected", count: 1, elapsedMs: expect.any(Number) });
  const ranks = listEvents(db, { project: P }).filter((e) => e.data.op === "memory_rank");
  expect(ranks.length).toBeGreaterThan(0);
  for (const r of ranks) expect(r.data.elapsedMs).toEqual(expect.any(Number));
});

test("审查单记 order = review", () => {
  recordMemory(db, { actor: "pm", now: 2 }, pit("审查要看的坑"));
  const r = reviewOrderOf(db, { task: getTask(db, "T1")!, orderId: "T1:review:r1", node: "review", head: HEAD, auto: false }, dir, true);
  expect(r.ok).toBe(true);
  expect(attempts().map((e) => e.data)).toEqual([expect.objectContaining({ order: "review", result: "injected", orderId: "T1:review:r1" })]);
});

test("只读连接（bridge）上照样记：另开写连接", () => {
  const ro = new Database(path, { readwrite: true });
  ro.exec("PRAGMA query_only = 1");
  try {
    recordMemoryAttempt(ro, getTask(db, "T1")!, { orderId: "T1:x", channel: "local_take", order: "write", result: "empty", count: 0, elapsedMs: 1 });
  } finally { ro.close(); }
  expect(attempts().map((e) => e.data.orderId)).toEqual(["T1:x"]);
});
