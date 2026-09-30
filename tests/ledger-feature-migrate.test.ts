/**
 * 台账 v9 → v10（T84 feature 表）：先备份再迁移、重开幂等、现有任务 / 事件原样、备份失败不迁移。
 * 设了 LEDGER_COPY（生产库的只读拷贝，VACUUM INTO 出来的）时再对它的临时副本跑一遍；源文件只读不写。
 */
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ledgerBackupPath } from "../src/lib/ledger-backup.js";
import { FEATURE_SCHEMA } from "../src/lib/ledger-feature-schema.js";
import { closeLedger, LEDGER_MIGRATIONS, LEDGER_SCHEMA_VERSION, openLedger, schemaVersion } from "../src/lib/ledger-store.js";
import { createTask, moveStage } from "../src/lib/ledger-write.js";

const V9 = LEDGER_MIGRATIONS.indexOf(FEATURE_SCHEMA);

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "ledger-t84-")), "ledger.sqlite");
}

/** 按 v9 为止的迁移造一个旧库，放两张任务卡和几条事件 */
function makeV9(path: string): void {
  const raw = new Database(path);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const step of LEDGER_MIGRATIONS.slice(0, V9)) {
    if (typeof step === "function") step(raw);
    else for (const sql of step) raw.prepare(sql).run();
  }
  raw.exec(`PRAGMA user_version = ${V9}`);
  const ins = raw.prepare(`INSERT INTO tasks (id, project, title, kind, stage, agent, assigneeKind, assignee, rev, createdAt, updatedAt)
    VALUES (?, 'p', ?, 'code', ?, ?, ?, ?, ?, 0, 0)`);
  ins.run("T1", "旧卡一", "build", "agent-exec", "agent", "agent-exec", 3);
  ins.run("T2", "旧卡二", "done", null, null, null, 7);
  const ev = raw.prepare("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, 'owner', 'p', ?, 'note', '', '{}')");
  for (let i = 0; i < 3; i++) ev.run(i, "T1");
  raw.close();
}

type Row = Record<string, unknown>;
const dump = (db: Database, table: string, order: string): Row[] => db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as Row[];
const without = (rows: Row[], ...keys: string[]) => rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k))));

/** 迁移前后比对：现有表的每一行都原样在，新列只多出 null */
function migrateAndCompare(path: string): Database {
  const before = new Database(path, { readonly: true });
  const tables = ["items", "tasks", "events", "meta", "task_deps", "asks"];
  const snap = Object.fromEntries(tables.map((t) => [t, dump(before, t, "rowid")]));
  const from = schemaVersion(before);
  before.close();
  const db = openLedger(path);
  expect(schemaVersion(db)).toBe(LEDGER_SCHEMA_VERSION);
  for (const t of tables) expect(without(dump(db, t, "rowid"), "featureId", "origin", "originSeq")).toEqual(snap[t]);
  expect(dump(db, "tasks", "rowid").every((r) => r.featureId === null)).toBe(true);
  expect(dump(db, "events", "rowid").every((r) => r.origin === null && r.originSeq === null)).toBe(true);
  const bak = new Database(ledgerBackupPath(path, LEDGER_SCHEMA_VERSION), { readonly: true });
  expect(schemaVersion(bak)).toBe(from);
  expect(dump(bak, "tasks", "rowid")).toEqual(snap.tasks);
  bak.close();
  return db;
}

describe("v9 → v10", () => {
  test("先备份再迁移；现有任务 / 事件原样；新写的事件带 origin", () => {
    const path = tmpPath();
    makeV9(path);
    const db = migrateAndCompare(path);
    moveStage(db, { actor: "owner", now: 10 }, { taskId: "T1", from: "build", to: "review" });
    createTask(db, { actor: "owner", now: 11 }, { project: "p", id: "T3", title: "新卡", kind: "code" });
    const fresh = db.prepare("SELECT origin, originSeq FROM events WHERE origin IS NOT NULL ORDER BY seq").all() as Row[];
    expect(fresh.map((r) => r.originSeq)).toEqual([1, 2]);
    closeLedger(path);
  });

  test("重开幂等：不再备份、不改库；迁移步骤本身重跑也不报错", () => {
    const path = tmpPath();
    makeV9(path);
    openLedger(path);
    closeLedger(path);
    const bak = ledgerBackupPath(path, LEDGER_SCHEMA_VERSION);
    const mtime = statSync(bak).mtimeMs;
    const db = openLedger(path);
    expect(statSync(bak).mtimeMs).toBe(mtime);
    expect(readdirSync(join(path, "..", "backups"))).toEqual([`ledger.sqlite.pre-v${LEDGER_SCHEMA_VERSION}.bak`]);
    FEATURE_SCHEMA(db);
    FEATURE_SCHEMA(db);
    expect(schemaVersion(db)).toBe(LEDGER_SCHEMA_VERSION);
    closeLedger(path);
  });

  test("备份失败就不迁移：报错，库仍是 v9", () => {
    const path = tmpPath();
    makeV9(path);
    writeFileSync(join(path, "..", "backups"), "不是目录");
    expect(() => openLedger(path)).toThrow(/备份失败/);
    const raw = new Database(path, { readonly: true });
    expect(schemaVersion(raw)).toBe(V9);
    raw.close();
  });

  test("版本号已被别的分支占到目标版本、feature 表还缺：补迁移前也先备份，补齐后重开不再备份", () => {
    const path = tmpPath();
    makeV9(path);
    const raw = new Database(path);
    raw.prepare("CREATE TABLE other_branch (x TEXT)").run();
    raw.exec(`PRAGMA user_version = ${LEDGER_SCHEMA_VERSION}`);
    const tasks = dump(raw, "tasks", "rowid");
    raw.close();
    const hasFeatures = (d: Database) => !!d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'features'").get();
    expect(hasFeatures(openLedger(path))).toBe(true);
    closeLedger(path);
    const dir = join(path, "..", "backups");
    const baks = readdirSync(dir);
    expect(baks).toHaveLength(1);
    const bak = new Database(join(dir, baks[0]), { readonly: true });
    expect(hasFeatures(bak)).toBe(false);
    expect(dump(bak, "tasks", "rowid")).toEqual(tasks);
    bak.close();
    openLedger(path);
    closeLedger(path);
    expect(readdirSync(dir)).toEqual(baks);
  });

  test("新库（v0）不备份", () => {
    const path = tmpPath();
    openLedger(path);
    closeLedger(path);
    expect(readdirSync(join(path, "..")).includes("backups")).toBe(false);
  });

  const copy = process.env.LEDGER_COPY;
  test.skipIf(!copy)("生产库拷贝（LEDGER_COPY）：迁移后每张卡、每条事件原样", () => {
    const path = tmpPath();
    copyFileSync(copy as string, path);
    const db = migrateAndCompare(path);
    expect((db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBeGreaterThan(100);
    closeLedger(path);
  });
});
