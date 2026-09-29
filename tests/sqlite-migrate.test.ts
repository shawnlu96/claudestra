import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { missingSchema, runMigrations, schemaVersion, type SchemaSpec } from "../src/lib/sqlite-migrate.js";

const V1 = ["CREATE TABLE a (id TEXT PRIMARY KEY)", "CREATE TABLE b (id TEXT PRIMARY KEY)"];
const addCol = (db: Database): void => {
  const cols = new Set((db.prepare("PRAGMA table_info(a)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("x")) db.prepare("ALTER TABLE a ADD COLUMN x TEXT").run();
};
const IDX = ["CREATE INDEX IF NOT EXISTS a_x ON a(x)"];
const spec = (migrations: SchemaSpec["migrations"]): SchemaSpec => ({
  label: "测试库", migrations, tables: ["a", "b"], columns: { a: ["id", "x"] }, indexes: { a: ["a_x"] },
});

describe("runMigrations", () => {
  test("新库一路升到最新，版本号 = 步数", () => {
    const db = new Database(":memory:");
    runMigrations(db, spec([V1, addCol, IDX]));
    expect(schemaVersion(db)).toBe(3);
    expect(missingSchema(db, spec([V1, addCol, IDX]))).toEqual([]);
  });

  test("已是最新再开一次什么都不做", () => {
    const db = new Database(":memory:");
    runMigrations(db, spec([V1, addCol, IDX]));
    db.prepare("INSERT INTO a (id, x) VALUES ('1', 'keep')").run();
    runMigrations(db, spec([V1, addCol, IDX]));
    expect(db.prepare("SELECT x FROM a").get()).toEqual({ x: "keep" });
  });

  test("旧库只跑缺的步骤", () => {
    const db = new Database(":memory:");
    runMigrations(db, { ...spec([V1]), columns: {}, indexes: {} });
    expect(schemaVersion(db)).toBe(1);
    runMigrations(db, spec([V1, addCol, IDX]));
    expect(schemaVersion(db)).toBe(3);
  });

  test("版本号到了但缺列（别的分支先占了这个号）：从第 2 步起重跑补齐", () => {
    const db = new Database(":memory:");
    for (const sql of V1) db.prepare(sql).run();
    db.exec("PRAGMA user_version = 3");
    runMigrations(db, spec([V1, addCol, IDX]));
    expect(missingSchema(db, spec([V1, addCol, IDX]))).toEqual([]);
  });

  test("库比代码新（分支代码先升过）不报错，只核对自己要的", () => {
    const db = new Database(":memory:");
    runMigrations(db, spec([V1, addCol, IDX]));
    db.exec("PRAGMA user_version = 9");
    expect(() => runMigrations(db, spec([V1, addCol, IDX]))).not.toThrow();
    expect(schemaVersion(db)).toBe(9);
  });

  test("某一步失败整体回滚，报错带回滚后的版本号", () => {
    const db = new Database(":memory:");
    runMigrations(db, { ...spec([V1]), columns: {}, indexes: {} });
    const bad = ["CREATE TABLE c (id TEXT)", "INSERT INTO nope VALUES (1)"];
    expect(() => runMigrations(db, spec([V1, bad]))).toThrow(/测试库迁移失败.*库仍是 v1/);
    expect(schemaVersion(db)).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'c'").get()).toBeNull();
  });

  test("补完仍缺就报错，不带着残缺的库往下跑", () => {
    const db = new Database(":memory:");
    expect(() => runMigrations(db, { ...spec([V1]), tables: ["a", "b", "ghost"] })).toThrow(/仍缺：ghost/);
    expect(schemaVersion(db)).toBe(0);
  });
});
