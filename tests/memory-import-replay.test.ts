import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMemoryImport, planMemoryImport } from "../src/lib/memory-import.js";
import { getMemory } from "../src/lib/ledger-memory.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";

let dir: string, path: string, db: Database;
const ctx = { actor: "agent-pm", now: 1000 };
const row = { kind: "pitfall", title: "事务写入必须同步", symptom: "只提交一部分", rule: "事务内不能 await",
  files: ["src/a.ts"], family: "sync-tx", fixable: false, feature: "ab12-f1", task: "N1", sourceNote: "PM import", visibility: "team" };
const raw = JSON.stringify(row);
const counts = () => ["memories", "memory_marks", "events"].map((t) => (db.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-replay-"));
  path = join(dir, "ledger.sqlite");
  db = openLedger(path);
  db.prepare("INSERT INTO ledger_instance(key,value) VALUES ('origin','ab12')").run();
  for (const id of ["ab12-f1", "ab12-f2"]) {
    db.prepare("INSERT INTO features(id,project,title,status,createdBy,createdAt,updatedAt) VALUES (?,'demo',?,'active','pm',1,1)").run(id, id);
  }
  createTask(db, { actor: "owner" }, { project: "demo", id: "N1", title: "demo", kind: "code" });
  db.prepare("UPDATE tasks SET featureId = 'ab12-f1', headSHA = 'old-head', specRev = 2 WHERE id = 'N1'").run();
});
afterEach(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });

test("rerun-anchor-1：卡改挂后相同 JSONL 零写入，保留原 feature/head/specRev", () => {
  const first = applyMemoryImport(db, ctx, "demo", raw);
  const old = getMemory(db, first.imported[0]!);
  db.prepare("UPDATE tasks SET featureId = 'ab12-f2', headSHA = 'new-head', specRev = 3 WHERE id = 'N1'").run();
  const before = counts(), backups = readdirSync(join(dir, "backups"));
  const plan = planMemoryImport(db, ctx, "demo", raw);
  expect(plan.issues).toEqual([]);
  expect(plan.rows[0]).toMatchObject({ replay: true, memory: { featureId: "ab12-f1", head: "old-head", specRev: 2 } });
  expect(applyMemoryImport(db, ctx, "demo", raw)).toEqual({ backup: null, imported: [], replayed: first.imported });
  expect(counts()).toEqual(before);
  expect(getMemory(db, first.imported[0]!)).toEqual(old);
  expect(readdirSync(join(dir, "backups"))).toEqual(backups);
});

test("未命中回执的新行仍核当前锚点，改挂后旧 feature 不可新导入", () => {
  applyMemoryImport(db, ctx, "demo", raw);
  db.prepare("UPDATE tasks SET featureId = 'ab12-f2' WHERE id = 'N1'").run();
  const fresh = JSON.stringify({ ...row, title: "另一条事务约束", family: "new-tx" });
  const before = counts();
  expect(planMemoryImport(db, ctx, "demo", fresh).issues).toMatchObject([{ line: 1, kind: "anchor" }]);
  expect(() => applyMemoryImport(db, ctx, "demo", fresh)).toThrow("清单有问题");
  expect(counts()).toEqual(before);
});

test("历史重跑不让混批新行跳过脱敏或身份字段拒绝", () => {
  applyMemoryImport(db, ctx, "demo", raw);
  db.prepare("UPDATE tasks SET featureId = 'ab12-f2' WHERE id = 'N1'").run();
  const variants = [
    { row: { ...row, rule: ["sk", "abcdefghijklmnopqrstuv"].join("-") }, kind: "redaction" },
    { row: { ...row, authorRole: "owner" }, kind: "format" },
  ];
  for (const variant of variants) {
    const mixed = raw + "\n" + JSON.stringify(variant.row), before = counts();
    const plan = planMemoryImport(db, ctx, "demo", mixed);
    expect(plan.rows[0]?.replay).toBe(true);
    expect(plan.issues).toMatchObject([{ line: 2, kind: variant.kind }]);
    expect(() => applyMemoryImport(db, ctx, "demo", mixed)).toThrow("清单有问题");
    expect(counts()).toEqual(before);
  }
});
