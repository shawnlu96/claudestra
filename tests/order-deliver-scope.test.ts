import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, deliver, setMeta } from "../src/lib/ledger-write.js";
import { deliverOrder } from "../src/lib/order-deliver.js";
import { ensureDeliverScope, ensureReviewScope, scopeInputs, SCOPE_RETRY_MS } from "../src/lib/order-deliver-scope.js";
import { scopeNumstat } from "../src/lib/order-deliver-scope-git.js";
import { reviewOrderOf } from "../src/lib/review-order.js";
import { workOrderFor } from "../src/lib/scheduler-work-order.js";
import { cancelLend, offerLend } from "../src/lib/ledger-lend.js";
import type { SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";

let db: Database, path: string, dir: string;
const H = "a".repeat(40), B = "b".repeat(40);
const task = () => getTask(db, "T1")!;
const files = [
  { path: "src/inside.ts", added: 1, deleted: 2 }, { path: "src/shared.ts", added: 3, deleted: 4 },
  { path: "tests/new.test.ts", added: 5, deleted: 0 }, { path: "asset.bin", added: null, deleted: null },
];
const read = async () => ({ base: B, files });
const listed = (head = H) => scopeInputs(db, task(), head).join("\n");
const notes = () => listEvents(db, { target: "T1" }).filter((e) => e.data.op === "deliver_scope");
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deliver-scope-")); path = join(dir, "ledger.db"); db = openLedger(path);
  const spec = join(dir, "T1.md"); writeFileSync(spec, "# test\n## 验收线\n逐条核对\n");
  setMeta(db, { actor: "owner" }, { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, { actor: "owner" }, { id: "T1", project: "p", title: "范围", kind: "code", spec, extra: { fileGlobs: ["src/inside.ts"] } });
  createTask(db, { actor: "owner" }, { id: "T2", project: "p", title: "共改", kind: "code", extra: { fileGlobs: ["src/*.ts"] } });
  createTask(db, { actor: "owner" }, { id: "T3", project: "p", title: "已完成", kind: "code", extra: { fileGlobs: ["tests/**"] } });
  db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T2'");
  db.run("UPDATE tasks SET stage = 'done' WHERE id = 'T3'");
  db.run("UPDATE tasks SET stage = 'review', round = 1, headSHA = ?, pr = 'https://github.com/o/r/pull/1' WHERE id = 'T1'", [H]);
});
afterEach(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });

test("records per-file additions/deletions, binary files, and overlap with running or merging cards; retries dedup across restart", async () => {
  db.run("UPDATE tasks SET stage = 'merge' WHERE id = 'T3'");
  await ensureDeliverScope(db, task(), H, read);
  const text = listed();
  expect(text).not.toContain('"src/inside.ts"');
  expect(text).toContain("+3 / -4（7 行）");
  expect(text).toContain("与 T2 共改，冲突两边保留");
  expect(text).toContain('"tests/new.test.ts"：+5 / -0（5 行）；与 T3 共改');
  expect(text).toContain("二进制");
  expect(text).toContain("理由不充分记 P2");
  closeLedger(path); db = openLedger(path);
  await ensureDeliverScope(db, task(), H, async () => { throw new Error("must not refetch"); });
  expect(listed()).toBe(text);
  expect(notes()).toHaveLength(1);
  expect(notes()[0].data).toMatchObject({ head: H, base: B, files: [{ path: "src/shared.ts", added: 3, deleted: 4, sharedWith: ["T2"] },
    { path: "tests/new.test.ts", added: 5, deleted: 0, sharedWith: ["T3"] }, { path: "asset.bin", added: null, deleted: null, sharedWith: [] }] });
});

test("unavailable fetch records one warning, backs off, then a later attempt repairs it", async () => {
  let calls = 0;
  const fail = async () => { calls++; throw new Error("fetch failed"); };
  const t0 = Date.now();
  await ensureDeliverScope(db, task(), H, fail, t0);
  await ensureDeliverScope(db, task(), H, fail, t0 + 1000);
  expect(calls).toBe(1);
  expect(listed()).toContain("规格外文件未能登记");
  expect(listEvents(db, { target: "T1" }).filter((e) => e.data.op === "deliver_scope_unavailable")).toHaveLength(1);
  await ensureDeliverScope(db, task(), H, read, t0 + SCOPE_RETRY_MS);
  expect(listed()).toContain("src/shared.ts");
  expect(notes()).toHaveLength(1);
});

test("a card without fileGlobs has no scope to compare: no event, no line, order bytes unchanged", async () => {
  db.run("UPDATE tasks SET extra = '{}' WHERE id = 'T1'");
  await ensureDeliverScope(db, task(), H, async () => { throw new Error("must not read"); });
  expect(listed()).toBe("");
  expect(listEvents(db, { target: "T1" }).filter((e) => String(e.data.op).startsWith("deliver_scope"))).toHaveLength(0);
});

test("nothing registered yet: the review order says so instead of inventing a list", () => {
  expect(listed()).toContain("还没有登记记录");
});

test("a query-only bridge connection uses a separate note-only writer", async () => {
  const ro = new Database(path, { readwrite: true }); ro.exec("PRAGMA query_only = ON");
  try { await ensureDeliverScope(ro, task(), H, read); }
  finally { ro.close(); }
  expect(notes()).toHaveLength(1);
});

test("local, scheduler and pool review inputs carry the same registered list without another event", async () => {
  await ensureDeliverScope(db, task(), H, read);
  const local = reviewOrderOf(db, { task: task(), orderId: "T1:review:r1", node: "review", head: H, auto: false });
  expect(local.ok && local.order.inputs.join("\n")).toContain("src/shared.ts");
  const intent = { id: "order", taskId: "T1", node: "adversarial_review", specRev: 1, head: H } as SchedulerIntent;
  const scheduler = workOrderFor(task(), intent, null, { taskId: "T1", role: "reviewer", agent: "agent-r", sessionId: "s", family: "codex", transport: "acp" }, undefined, db);
  expect(scheduler?.inputs.join("\n")).toContain("src/shared.ts");
  const pool = offerLend(db, { actor: "owner" }, { taskId: "T1", peer: "mate", family: "codex", repo: "o/r", pr: 1,
    spec: "# 范围", borrow: { peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 3 } });
  expect(JSON.stringify(pool)).toContain("src/shared.ts");
  expect(notes()).toHaveLength(1);
});

test("pool offer never runs git or writes inside its transaction; the pre-offer hook registers outside it", async () => {
  const pool = offerLend(db, { actor: "owner" }, { taskId: "T1", peer: "mate", family: "codex", repo: "o/r", pr: 1,
    spec: "# 范围", borrow: { peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 3 } });
  expect(JSON.stringify(pool)).toContain("还没有登记记录");
  expect(listEvents(db, { target: "T1" }).filter((e) => String(e.data.op).startsWith("deliver_scope"))).toHaveLength(0);
  // ensureReviewScope：卡在 review 才登记；其它阶段什么都不做
  db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T1'");
  await ensureReviewScope(db, "T1");
  db.run("UPDATE tasks SET stage = 'review' WHERE id = 'T1'");
  expect(listEvents(db, { target: "T1" }).filter((e) => String(e.data.op).startsWith("deliver_scope"))).toHaveLength(0);
});

test("NUL numstat preserves unusual paths and no-renames lists both ends", () => {
  expect(scopeNumstat("0\t8\told.ts\x0010\t0\tnew\tname\n.ts\x00-\t-\tasset.bin\x00")).toEqual([
    { path: "old.ts", added: 0, deleted: 8 }, { path: "new\tname\n.ts", added: 10, deleted: 0 }, { path: "asset.bin", added: null, deleted: null },
  ]);
  expect(() => scopeNumstat("bad\0")).toThrow();
});

test("a large PR list stays in the event and cannot overflow a long pool specification", async () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ path: `src/outside-${i}.ts`, added: i, deleted: 0 }));
  await ensureDeliverScope(db, task(), H, async () => ({ base: B, files: many }));
  const pool = offerLend(db, { actor: "owner" }, { taskId: "T1", peer: "mate", family: "codex", repo: "o/r", pr: 1,
    spec: "spec line\n".repeat(2700), borrow: { peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 3 } });
  expect(JSON.stringify(pool)).toContain("完整规格外文件清单见 T1");
  expect(notes()[0].data.files).toHaveLength(400);
});

test("pool review stays dispatchable after a failed registration: no full SHA leaks into inputs", async () => {
  await ensureDeliverScope(db, task(), H, async () => { throw new Error(`fetch ${H} failed`); });
  const pool = offerLend(db, { actor: "owner" }, { taskId: "T1", peer: "mate", family: "codex", repo: "o/r", pr: 1,
    spec: "# 范围", borrow: { peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 3 } });
  expect(JSON.stringify(pool)).toContain("规格外文件未能登记");
});

test("deliver still succeeds when scope collection is unavailable and records the failure before returning", async () => {
  db.run("UPDATE tasks SET stage = 'build', round = 0, agent = 'agent-author', assigneeKind = 'agent', assignee = 'agent-author', branch = 'feature' WHERE id = 'T1'");
  const r = await deliverOrder({ agent: "agent-author", sessionId: "s", family: "codex", channelId: "c" },
    { v: 1, orderId: "T1:write:r0", head: H, evidence: "report.md", summary: "完成", selfCheck: "完成" }, {
      db, remoteHead: async () => ({ ok: true, head: H }),
      findPr: async () => ({ ok: true, rows: [{ url: task().pr!, headRefOid: H, baseRefName: "main", isCrossRepository: false }] }),
      run: async () => ({ ok: true, ...deliver(db, { actor: "agent-author" }, { taskId: "T1", headSHA: H, moveFrom: "build" }) }),
    });
  expect(r).toMatchObject({ ok: true, stage: "review" });
  expect(listEvents(db, { target: "T1" }).filter((e) => e.data.op === "deliver_scope_unavailable")).toHaveLength(1);
});

test("CLI deliver registers outside the transaction too, so a manual card's local take_review is not left without a record", async () => {
  db.run("UPDATE tasks SET stage = 'build', round = 0, agent = 'agent-author' WHERE id = 'T1'");
  const r = await runLedger(["deliver", "T1", "--from", "build", "--head", H], { db, actor: "owner", projectIds: ["p"], now: () => Date.now(),
    loadRegistry: async () => ({ agents: {} }) as unknown as Registry, saveRegistry: async () => {} });
  expect(r).toMatchObject({ ok: true });
  expect(task().stage).toBe("review");
  // 测试里读不到真仓库，登记落成「未能登记」；关键是登记跑过了，审查单不再是「还没有登记记录」
  expect(listEvents(db, { target: "T1" }).filter((e) => String(e.data.op).startsWith("deliver_scope"))).toHaveLength(1);
  expect(listed()).not.toContain("还没有登记记录");
});

test("long prior findings are fitted first: the pool order keeps the registered list (or at least its pointer)", async () => {
  db.run("UPDATE tasks SET round = 2 WHERE id = 'T1'");
  const findings = Array.from({ length: 7 }, (_, i) => ({ findingId: `F${i}`, family: "f", severity: "P1", probe: "repro text. ".repeat(280) }));
  db.query("INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (100,'agent-rv','p','T1','review','',?)")
    .run(JSON.stringify({ round: 1, verdict: "changes", findings, p0: 0, p1: 7, p2: 0, path: "reviews/T1-r1.md" }));
  await ensureDeliverScope(db, task(), H, async () => ({ base: B, files: [{ path: "src/outside.ts", added: 2, deleted: 1 }] }));
  const offer = (spec: string) => JSON.stringify(offerLend(db, { actor: "owner" }, { taskId: "T1", peer: "mate", family: "codex", repo: "o/r", pr: 1,
    spec, borrow: { peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 3 } }));
  const pool = offer("spec line\n".repeat(1200));
  expect(pool).toContain("上一轮逐项结论单子装不下");
  expect(pool).toContain("src/outside.ts");
  const local = reviewOrderOf(db, { task: task(), orderId: "T1:review:r2", node: "review", head: H, auto: false });
  expect(local.ok && local.order.inputs.join("\n")).toContain("src/outside.ts");
});

test("near the wire cap the pointer is mandatory: every pool offer either carries it or is refused", async () => {
  await ensureDeliverScope(db, task(), H, async () => ({ base: B, files: [{ path: "src/out.ts", added: 1, deleted: 0 }] }));
  const offer = (lines: number) => offerLend(db, { actor: "owner" }, { taskId: "T1", peer: "mate", family: "codex", repo: "o/r", pr: 1,
    spec: "spec line\n".repeat(lines), borrow: { peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 3 } });
  // 第 3 轮复现：2850 行时单子到 32 KiB 边上，之前会静默丢掉清单和指针
  expect(() => offer(2850)).toThrow("放不下规格外文件指针");
  let carried = 0;
  for (const lines of [2800, 2830, 2840, 2850, 2860]) {
    // 拒单（本卡的指针拒单，或不带范围也超限的格式拒单）都行；只要出了单，就必须带指针
    let made: string | null = null;
    try { made = JSON.stringify(offer(lines)); } catch { continue; /* 拒单正是允许的结果之一，下一档 */ }
    expect(made).toContain("deliver_scope");
    carried++;
    cancelLend(db, { actor: "owner" }, { taskId: "T1", reason: "下一档" });
  }
  expect(carried).toBeGreaterThan(0);
}, 30_000); // 五次真实挂池、每次压 32 KiB 的单：负载高时超过默认 5 秒
