import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMemoryImport, importVectorKey, planMemoryImport } from "../src/lib/memory-import.js";
import { importVectors } from "../src/lib/memory-import-vectors.js";
import { recordMemory, type MemoryInput } from "../src/lib/ledger-memory.js";
import { LedgerError, closeLedger, openLedger } from "../src/lib/ledger-store.js";
import type { Embedder } from "../src/lib/memory-embed.js";

// vec-tx-stale-1: vectors are precomputed before the write lock; memories that appear afterwards must be reported, not silently unchecked.
let dir: string, path: string, db: Database;
const ctx = { actor: "agent-pm", now: 1000 };
const row = { kind: "pitfall", title: "事务回调不能 await", symptom: "事务提前提交", rule: "事务内必须同步写",
  files: ["src/lib/widget.ts"], family: "widget-tx", fixable: false, feature: null, task: null, sourceNote: "PM 私人记忆导入", visibility: "team" };
const text = JSON.stringify(row);
const pitfall = (extra: Partial<MemoryInput>): MemoryInput => ({ project: "demo", kind: "pitfall", title: "分页必须固定排序", symptom: "翻页漏行",
  rule: "查询必须稳定排序", files: ["src/page.ts"], family: "paging", fixable: false, via: "tool", authorRole: "pm", sourceNote: "review", ...extra } as MemoryInput);
// "sync" texts cluster together; everything else is orthogonal.
const embedder: Embedder = { model: "test", remote: false, embed: async (texts) => texts.map((t) => t.includes("同步") ? [0, 1] : [1, 0]) };
const counts = (d = db) => ["memories", "memory_marks", "events"].map((t) => (d.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
const receipts = () => (db.query("SELECT COUNT(*) AS n FROM events WHERE dedupKey LIKE 'import:%'").get() as { n: number }).n;
/** A separate connection on the same file plays the concurrent writer. */
const otherWriter = (input: MemoryInput) => {
  const peer = new Database(path);
  try { return recordMemory(peer, ctx, input).memory; } finally { peer.close(); }
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-import-stale-")); path = join(dir, "ledger.sqlite");
  db = openLedger(path);
  db.prepare("INSERT INTO ledger_instance(key,value) VALUES ('origin','ab12')").run();
  recordMemory(db, ctx, pitfall({}));
});
afterEach(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });

test("预计算后插入的新记忆无向量：锁内给 semantic 退化告警，备份/权限重核、整批原子写，重放零写入", async () => {
  const vectors = await importVectors(db, planMemoryImport(db, ctx, "demo", text), embedder);
  expect(planMemoryImport(db, ctx, "demo", text, vectors)).toMatchObject({ issues: [], semanticGaps: [] });
  const late = otherWriter(pitfall({ title: "写入整批同步", rule: "写入必须同步", files: ["src/store.ts"], family: "store-tx" }));
  // Control: with fresh vectors the late memory is a semantic duplicate, so skipping it would be a silent false "done".
  const fresh = await importVectors(db, planMemoryImport(db, ctx, "demo", text), embedder);
  expect(planMemoryImport(db, ctx, "demo", text, fresh).issues).toMatchObject([{ line: 1, kind: "duplicate", duplicateOf: late.id }]);

  let authorized = 0;
  const r = applyMemoryImport(db, ctx, "demo", text, vectors, () => { expect(db.inTransaction).toBe(true); authorized++; });
  expect(authorized).toBe(1);
  expect(r.imported).toHaveLength(1);
  expect(r.semantic).toMatchObject({ status: "degraded", gaps: [{ line: 1, self: false, missing: [late.id] }] });
  expect(r.semantic?.status === "degraded" && r.semantic.reason).toContain("精确内容与 family + 文件判重已在锁内执行");
  const backup = new Database(r.backup!, { readonly: true });
  try { expect(counts(backup)).toEqual([2, 0, 2]); } finally { backup.close(); } // backup reflects the late write, not the precompute snapshot
  expect(receipts()).toBe(1);

  const before = counts(), backups = readdirSync(join(dir, "backups"));
  expect(applyMemoryImport(db, ctx, "demo", text, vectors)).toEqual({ backup: null, imported: [], replayed: r.imported });
  expect(counts()).toEqual(before);
  expect(readdirSync(join(dir, "backups"))).toEqual(backups);
});

test("拿锁前插入的新记忆与清单行 family + 文件重复：锁内精确判重仍拒，整批零写入", async () => {
  const vectors = await importVectors(db, planMemoryImport(db, ctx, "demo", text), embedder);
  const before = counts();
  let late = "";
  // authorize runs right after the IMMEDIATE lock: the write lands after the unlocked plan and the backup.
  let err: unknown;
  try {
    applyMemoryImport(db, ctx, "demo", text, vectors, () => {
      late = recordMemory(db, ctx, pitfall({ title: "另一种写法", files: ["src/lib/widget.ts"], family: "widget-tx" })).memory.id;
    });
  } catch (e) { err = e; }
  expect(err).toBeInstanceOf(LedgerError);
  expect((err as LedgerError).current?.issues).toMatchObject([{ line: 1, kind: "duplicate", duplicateOf: late }]);
  expect(counts()).toEqual(before);
  expect(receipts()).toBe(0);
  expect(readdirSync(join(dir, "backups"))).toHaveLength(1);
});

test("行自身无向量记 self 缺口；未启用语义时结果不带 semantic 字段", async () => {
  const p = planMemoryImport(db, ctx, "demo", text);
  const partial = new Map([...(await importVectors(db, p, embedder))].filter(([k]) => k !== importVectorKey(p.rows[0]!.memory)));
  expect(planMemoryImport(db, ctx, "demo", text, partial).semanticGaps).toEqual([{ line: 1, self: true, missing: [] }]);
  const plain = applyMemoryImport(db, ctx, "demo", text);
  expect(plain.imported).toHaveLength(1);
  expect("semantic" in plain).toBe(false);
});
