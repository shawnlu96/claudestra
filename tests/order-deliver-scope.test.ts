import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, deliver, setMeta } from "../src/lib/ledger-write.js";
import { deliverOrder } from "../src/lib/order-deliver.js";
import { ensureDeliverScope } from "../src/lib/order-deliver-scope.js";
import { scopeNumstat } from "../src/lib/order-deliver-scope-git.js";
import { reviewOrderOf } from "../src/lib/review-order.js";
import { workOrderFor } from "../src/lib/scheduler-work-order.js";
import { offerLend } from "../src/lib/ledger-lend.js";
import type { SchedulerIntent } from "../src/lib/ledger-scheduler.js";

let db: Database, path: string, dir: string;
const H = "a".repeat(40), B = "b".repeat(40);
const task = () => getTask(db, "T1")!;
const files = [
  { path: "src/inside.ts", added: 1, deleted: 2 }, { path: "src/shared.ts", added: 3, deleted: 4 },
  { path: "tests/new.test.ts", added: 5, deleted: 0 }, { path: "asset.bin", added: null, deleted: null },
];
const read = () => ({ base: B, files });
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

test("records per-file additions/deletions, binary files, and overlap with running cards; retries dedup across restart", () => {
  const text = ensureDeliverScope(db, task(), H, read).join("\n");
  expect(text).not.toContain('"src/inside.ts"');
  expect(text).toContain("+3 / -4（7 行）");
  expect(text).toContain("与 T2 共改，冲突两边保留");
  expect(text).not.toContain("T3");
  expect(text).toContain("二进制");
  expect(text).toContain("理由不充分记 P2");
  closeLedger(path); db = openLedger(path);
  expect(ensureDeliverScope(db, task(), H, () => { throw new Error("must not refetch"); }).join("\n")).toBe(text);
  expect(notes()).toHaveLength(1);
  expect(notes()[0].data).toMatchObject({ head: H, base: B, files: [{ path: "src/shared.ts", added: 3, deleted: 4, sharedWith: ["T2"] },
    { path: "tests/new.test.ts", added: 5, deleted: 0, sharedWith: [] }, { path: "asset.bin", added: null, deleted: null, sharedWith: [] }] });
});

test("unavailable fetch records one warning, does not throw, then a later attempt repairs it", () => {
  const fail = () => { throw new Error("fetch failed"); };
  for (let i = 0; i < 2; i++) expect(ensureDeliverScope(db, task(), H, fail)[0]).toContain("规格外文件未能登记");
  expect(listEvents(db, { target: "T1" }).filter((e) => e.data.op === "deliver_scope_unavailable")).toHaveLength(1);
  expect(ensureDeliverScope(db, task(), H, read)[0]).toContain("src/shared.ts");
  expect(notes()).toHaveLength(1);
});

test("a query-only bridge connection uses a separate note-only writer", () => {
  const ro = new Database(path, { readwrite: true }); ro.exec("PRAGMA query_only = ON");
  try { expect(ensureDeliverScope(ro, task(), H, read)[0]).toContain("src/shared.ts"); }
  finally { ro.close(); }
  expect(notes()).toHaveLength(1);
});

test("local, scheduler and pool review inputs carry the same registered list without another event", () => {
  ensureDeliverScope(db, task(), H, read);
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

test("NUL numstat preserves unusual paths and no-renames lists both ends", () => {
  expect(scopeNumstat("0\t8\told.ts\x0010\t0\tnew\tname\n.ts\x00-\t-\tasset.bin\x00")).toEqual([
    { path: "old.ts", added: 0, deleted: 8 }, { path: "new\tname\n.ts", added: 10, deleted: 0 }, { path: "asset.bin", added: null, deleted: null },
  ]);
  expect(() => scopeNumstat("bad\0")).toThrow();
});

test("a large PR list stays in the event and cannot overflow a long pool specification", () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ path: `src/outside-${i}.ts`, added: i, deleted: 0 }));
  ensureDeliverScope(db, task(), H, () => ({ base: B, files: many }));
  const pool = offerLend(db, { actor: "owner" }, { taskId: "T1", peer: "mate", family: "codex", repo: "o/r", pr: 1,
    spec: "spec line\n".repeat(2700), borrow: { peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 3 } });
  expect(JSON.stringify(pool)).toContain("完整规格外文件清单见 T1");
  expect(notes()[0].data.files).toHaveLength(400);
});

test("pool review remains dispatchable when registration cannot fetch: no full SHA leaks into inputs", () => {
  const pool = offerLend(db, { actor: "owner" }, { taskId: "T1", peer: "mate", family: "codex", repo: "o/r", pr: 1,
    spec: "# 范围", borrow: { peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 3 } });
  expect(JSON.stringify(pool)).toContain("规格外文件未能登记");
  expect(listEvents(db, { target: "T1" }).filter((e) => e.data.op === "deliver_scope_unavailable")).toHaveLength(1);
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
