/** 记忆两张表的迁移与冻结（pmem-M1 验收线 1、2）。迁移号一律按 indexOf(MEMORY_SCHEMA) 算，不写死（并行分支会往数组里插） */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { MEMORY_SCHEMA, MEMORY_TABLES } from "../src/lib/ledger-memory-schema.js";
import { closeLedger, LEDGER_MIGRATIONS, LEDGER_TABLES, openLedger, schemaVersion } from "../src/lib/ledger-store.js";
import { missingSchema, runMigrations } from "../src/lib/sqlite-migrate.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const STEP = LEDGER_MIGRATIONS.indexOf(MEMORY_SCHEMA);
let path = "";
afterEach(() => {
  if (path) closeLedger(path);
  path = "";
});

const tables = (d: Database) => (d.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);

const MEM = `INSERT INTO memories (id, origin, originSeq, project, kind, title, body, fixable, via, author, authorRole, visibility, redactionVersion, digest, createdAt)
  VALUES (?, 'ab12', ?, 'p', 'pitfall', 't', '{"symptom":"s","rule":"r"}', 1, 'tool', 'agent-x', 'pm', 'team', 1, 'd', 1)`;
const MARK = "INSERT INTO memory_marks (origin, originSeq, memoryId, ts, actor, mark, dedupKey, source) VALUES ('ab12', ?, 'ab12-m1', 1, 'a', 'confirm', ?, ?)";

describe("迁移", () => {
  test("登记在迁移数组里；建出两张表；LEDGER_TABLES 含它们", () => {
    expect(STEP).toBeGreaterThan(0);
    path = tempLedgerPath("ledger-memory-");
    const d = openLedger(path);
    expect(schemaVersion(d)).toBe(LEDGER_MIGRATIONS.length);
    for (const t of MEMORY_TABLES) expect(tables(d)).toContain(t);
    for (const t of MEMORY_TABLES) expect(LEDGER_TABLES as readonly string[]).toContain(t);
  });

  test("可重跑：同一库上再跑本步不报错、数据都在；版本号被撞回本步之前时打开会重跑补齐", () => {
    path = tempLedgerPath("ledger-memory-");
    let d = openLedger(path);
    d.prepare(MEM).run("ab12-m1", 1);
    MEMORY_SCHEMA(d);
    MEMORY_SCHEMA(d);
    d.exec(`PRAGMA user_version = ${STEP}`);
    closeLedger(path);
    d = openLedger(path);
    expect(schemaVersion(d)).toBe(LEDGER_MIGRATIONS.length);
    expect(d.query("SELECT id FROM memories").all()).toEqual([{ id: "ab12-m1" }]);
  });

  test("版本号到了但表缺（别的分支占了号）：打开自愈出两张表与索引", () => {
    path = tempLedgerPath("ledger-memory-");
    let d = openLedger(path);
    d.exec("DROP TABLE memory_marks");
    closeLedger(path);
    d = openLedger(path);
    expect(tables(d)).toContain("memory_marks");
    expect(d.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'memory_marks_memory'").get()).toBeTruthy();
  });

  test("旧代码能打开新库：只认本步之前的迁移与表时不报错、不降版本，旧表照常读写", () => {
    path = tempLedgerPath("ledger-memory-");
    openLedger(path);
    closeLedger(path);
    const d = new Database(path);
    const old = { label: "台账库", migrations: LEDGER_MIGRATIONS.slice(0, STEP), tables: LEDGER_TABLES.filter((t) => !(MEMORY_TABLES as readonly string[]).includes(t)) };
    expect(() => runMigrations(d, old)).not.toThrow();
    expect(missingSchema(d, old)).toEqual([]);
    expect(schemaVersion(d)).toBe(LEDGER_MIGRATIONS.length);
    d.prepare("INSERT INTO events (ts, actor, project, target, kind) VALUES (1, 'old', 'p', '', 'note')").run();
    expect(d.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
    d.close();
  });

  test("本步之前的库（上一版代码建的）升上来：有数据也不丢", () => {
    path = tempLedgerPath("ledger-memory-");
    const raw = new Database(path);
    for (const step of LEDGER_MIGRATIONS.slice(0, STEP)) typeof step === "function" ? step(raw) : step.forEach((sql) => raw.prepare(sql).run());
    raw.exec(`PRAGMA user_version = ${STEP}`);
    raw.prepare("INSERT INTO events (ts, actor, project, target, kind) VALUES (1, 'old', 'p', '', 'note')").run();
    raw.close();
    const d = openLedger(path);
    expect([schemaVersion(d), tables(d).includes("memories"), (d.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n]).toEqual([LEDGER_MIGRATIONS.length, true, 1]);
  });
});

describe("内容冻结 / 只追加（trigger）", () => {
  const fresh = () => {
    path = tempLedgerPath("ledger-memory-");
    const d = openLedger(path);
    d.prepare(MEM).run("ab12-m1", 1);
    d.prepare(MARK).run(1, "auto:confirm:ab12-m1::ab12/1", '{"origin":"ab12","originSeq":1}');
    return d;
  };

  test("memories：UPDATE / DELETE 被拦", () => {
    const d = fresh();
    expect(() => d.prepare("UPDATE memories SET title = 'x'").run()).toThrow(/append-only/);
    expect(() => d.prepare("DELETE FROM memories").run()).toThrow(/append-only/);
  });

  test("memories：同 id、同 (origin, originSeq) 的 INSERT 被拦，含 OR REPLACE / OR IGNORE 与 UPSERT", () => {
    const d = fresh();
    expect(() => d.prepare(MEM).run("ab12-m1", 1)).toThrow(/append-only/);
    expect(() => d.prepare(MEM.replace("INSERT", "INSERT OR REPLACE")).run("ab12-m1", 1)).toThrow(/append-only/);
    expect(() => d.prepare(MEM.replace("INSERT", "INSERT OR IGNORE")).run("ab12-m1", 1)).toThrow(/append-only/);
    expect(() => d.prepare(`${MEM} ON CONFLICT (id) DO UPDATE SET title = 'x'`).run("ab12-m1", 1)).toThrow(/append-only/);
    expect(d.query("SELECT title FROM memories").all()).toEqual([{ title: "t" }]);
  });

  test("memory_marks：UPDATE / DELETE / 同键 / 同 dedupKey 的 INSERT（含 REPLACE）被拦", () => {
    const d = fresh();
    expect(() => d.prepare("UPDATE memory_marks SET mark = 'retract'").run()).toThrow(/append-only/);
    expect(() => d.prepare("DELETE FROM memory_marks").run()).toThrow(/append-only/);
    expect(() => d.prepare(MARK).run(1, null, null)).toThrow(/append-only/);
    expect(() => d.prepare(MARK.replace("INSERT", "INSERT OR REPLACE")).run(2, "auto:confirm:ab12-m1::ab12/1", '{"seq":1}')).toThrow(/append-only/);
    expect(d.query("SELECT COUNT(*) AS n FROM memory_marks").get()).toEqual({ n: 1 });
  });

  test("CHECK：fixable 只给坑；id 与 origin/originSeq 对得上；dispute 要 reason；自动 mark 要 source", () => {
    const d = fresh();
    const bad = (sql: string, ...args: (string | number | null)[]) => expect(() => d.prepare(sql).run(...args)).toThrow();
    bad(MEM.replace("'pitfall'", "'summary'"), "ab12-m2", 2);
    bad(MEM, "ab12-m9", 3);
    bad("INSERT INTO memory_marks (origin, originSeq, memoryId, ts, actor, mark) VALUES ('ab12', 5, 'ab12-m1', 1, 'a', 'dispute')");
    bad("INSERT INTO memory_marks (origin, originSeq, memoryId, ts, actor, mark, dedupKey) VALUES ('ab12', 6, 'ab12-m1', 1, 'a', 'confirm', 'auto:x')");
    bad("INSERT INTO memory_marks (origin, originSeq, memoryId, ts, actor, mark) VALUES ('ab12', 7, 'ab12-m1', 1, 'a', 'fixed')");
  });
});
