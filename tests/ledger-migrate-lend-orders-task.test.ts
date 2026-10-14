/** v25（dispatch-recovery-SNAPSQL1）：lend_orders_task 索引走末尾追加的一步迁移；v24 库升级、重开空操作、版本已到但缺索引被修回 */
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerBackupPath } from "../src/lib/ledger-backup.js";
import { LEND_ORDERS_TASK_INDEX, LEND_ORDERS_TASK_SCHEMA } from "../src/lib/ledger-lend-schema.js";
import { closeLedger, LEDGER_MIGRATIONS, LEDGER_SCHEMA_VERSION, openLedger } from "../src/lib/ledger-store.js";
import { installProjectionGuard } from "../src/lib/scheduler-v2-retire-guard.js";
import { schemaVersion } from "../src/lib/sqlite-migrate.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });

function fixture(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ledger-v25-")), path = join(dir, "ledger.sqlite");
  cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  return { dir, path };
}

const hasIndex = (db: Database): boolean =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND tbl_name = 'lend_orders' AND name = 'lend_orders_task'").get();
const business = (db: Database) => ({
  orders: db.query("SELECT * FROM lend_orders ORDER BY orderId").all(),
  tasks: db.query("SELECT id, stage, agent FROM tasks ORDER BY id").all(),
});

/** openLedger 建库、写业务数据，然后退回 v24 的样子：删掉 lend_orders_task 并把 user_version 设成 targetVersion */
function seeded(path: string, targetVersion: number): void {
  const db = openLedger(path);
  db.query("INSERT INTO tasks (id, project, title, kind, stage, agent, createdAt, updatedAt) VALUES ('T1', 'p', 't', 'code', 'build', 'a', 0, 0)").run();
  db.query(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256, status,
    leaseMs, createdBy, createdAt, updatedAt) VALUES ('o1', 'T1', 'p', 'Sekai', 'claude', 'write', 1, 0, 'h', 'r', 'w', 't', 's', 'done', 1, 'pm', 0, 0)`).run();
  closeLedger(path);
  const raw = new Database(path);
  raw.exec("DROP INDEX lend_orders_task");
  raw.exec(`PRAGMA user_version = ${targetVersion}`);
  raw.close();
}

test("v25 是末尾追加的一步：只建 lend_orders_task，防护触发器仍是第 24 步", () => {
  expect(LEDGER_SCHEMA_VERSION).toBe(25);
  expect(LEDGER_MIGRATIONS.indexOf(installProjectionGuard) + 1).toBe(24);
  expect(LEDGER_MIGRATIONS.at(-1)).toBe(LEND_ORDERS_TASK_SCHEMA);
  expect(LEND_ORDERS_TASK_INDEX).toBe("CREATE INDEX IF NOT EXISTS lend_orders_task ON lend_orders(taskId)");
  // 可重跑：已有索引时再跑一遍不报错
  const { path } = fixture(); const db = openLedger(path);
  LEND_ORDERS_TASK_SCHEMA(db); LEND_ORDERS_TASK_SCHEMA(db); expect(hasIndex(db)).toBe(true);
});

test("[验收线 4] 新库直接有 lend_orders_task", () => {
  const { path } = fixture();
  const db = openLedger(path);
  expect(schemaVersion(db)).toBe(25); expect(hasIndex(db)).toBe(true);
});

test("[验收线 4] v24 库升级到 v25：索引在、业务数据不变、生成 pre-v25 备份；再开一次是空操作", () => {
  const { dir, path } = fixture();
  seeded(path, 24);
  const raw = new Database(path, { readonly: true });
  expect(hasIndex(raw)).toBe(false); const before = business(raw); raw.close();
  const db = openLedger(path);
  expect(schemaVersion(db)).toBe(25); expect(hasIndex(db)).toBe(true); expect(business(db)).toEqual(before);
  const backup = ledgerBackupPath(path, 25);
  expect(backup.endsWith("ledger.sqlite.pre-v25.bak")).toBe(true); expect(existsSync(backup)).toBe(true);
  const bak = new Database(backup, { readonly: true });
  expect(schemaVersion(bak)).toBe(24); expect(hasIndex(bak)).toBe(false); expect(business(bak)).toEqual(before); bak.close();
  closeLedger(path);
  const backups = readdirSync(join(dir, "backups"));
  const again = openLedger(path);
  expect(schemaVersion(again)).toBe(25); expect(hasIndex(again)).toBe(true); expect(business(again)).toEqual(before);
  expect(readdirSync(join(dir, "backups"))).toEqual(backups);
});

test("[验收线 4] 版本已是 25 但索引被删：重开后由 REQUIRED_INDEXES 核对修回", () => {
  const { path } = fixture();
  seeded(path, 25);
  const raw = new Database(path, { readonly: true });
  expect(hasIndex(raw)).toBe(false); const before = business(raw); raw.close();
  const db = openLedger(path);
  expect(schemaVersion(db)).toBe(25); expect(hasIndex(db)).toBe(true); expect(business(db)).toEqual(before);
});
