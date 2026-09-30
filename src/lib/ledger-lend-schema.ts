/**
 * lend_orders（T93，docs/design/remote-capacity.md §2.2、§6）：一张卡挂进出借池的那一单，本身就是出借意图——
 * 不复用 scheduler_intents：那张表的状态 CHECK 没有 pooled，planIntent 只收自动流程的卡，自动 tick 会取消没绑 session 的 pending。
 * 状态：pooled（等人领）→ claimed（某个 peer 持有租约）→ done（结论 / 交付已入账）| unknown（租约过期 / 对方报停，交 PM）|
 * cancelled（PM 撤单或重挂）| released（对方报 worker 从没起过）。一张卡同时最多一单未结（部分唯一索引）。
 * i28-R6：step 多了 write（开工单）/ fix（修复单），带 branch / base；lend_write_leases 记这张卡的写租约留在哪个出借方。
 * 迁移规矩同 ledger-store.ts：一条语句一次 prepare().run()，每步可重跑。tests/ledger-lend.test.ts、tests/ledger-lend-write.test.ts。
 */
import type { Database } from "bun:sqlite";

const LEND_ORDER_STATUSES = ["pooled", "claimed", "done", "unknown", "cancelled", "released"] as const;
export type LendOrderStatus = (typeof LEND_ORDER_STATUSES)[number];
/** 未结 = 还挡着这张卡再挂一单，也是 peer-ledger 拒写（lend_managed）的判据之一 */
export const LEND_LIVE: readonly LendOrderStatus[] = ["pooled", "claimed", "unknown"];

const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

const ordersTable = (name: string): string => `CREATE TABLE IF NOT EXISTS ${name} (
    orderId TEXT PRIMARY KEY, taskId TEXT NOT NULL, project TEXT NOT NULL, peer TEXT NOT NULL,
    family TEXT NOT NULL CHECK (family IN ('codex','claude')), step TEXT NOT NULL CHECK (step IN ('review','write','fix')),
    specRev INTEGER NOT NULL, round INTEGER NOT NULL, head TEXT NOT NULL, repo TEXT NOT NULL, pr INTEGER,
    wire TEXT NOT NULL, text TEXT NOT NULL, sha256 TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (${inList(LEND_ORDER_STATUSES)})),
    worker TEXT, leaseGen INTEGER NOT NULL DEFAULT 0, leaseMs INTEGER NOT NULL, leaseUntil INTEGER,
    resultSha TEXT, receipt TEXT, eventSeq INTEGER, reason TEXT, supersedes TEXT,
    createdBy TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, branch TEXT, base TEXT)`;

const ORDER_INDEXES: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS lend_orders_peer_status ON lend_orders(peer, status)",
  `CREATE UNIQUE INDEX IF NOT EXISTS lend_orders_live ON lend_orders(taskId) WHERE status IN (${inList(LEND_LIVE)})`,
];

export function LEND_SCHEMA(db: Database): void {
  for (const sql of [ordersTable("lend_orders"), ...ORDER_INDEXES]) db.prepare(sql).run();
}

/** T93 建的表（step 只收 review、没有 branch / base）原样搬进新表：SQLite 改不了 CHECK，只能重建 */
const T93_COLUMNS = "orderId, taskId, project, peer, family, step, specRev, round, head, repo, pr, wire, text, sha256, status, worker, leaseGen, " +
  "leaseMs, leaseUntil, resultSha, receipt, eventSeq, reason, supersedes, createdBy, createdAt, updatedAt";

/**
 * 写租约：一张卡第一次把开工单借给某个出借方时建（held），合并前修复单都优先派回它；PM 收回、派不回去（离线 / 名额满 / 授权过期）
 * 时结束（ended，带原因）。prevAssignee* 是借出去之前卡上的负责人，收回时还原。
 */
const LEASES_SQL = `CREATE TABLE IF NOT EXISTS lend_write_leases (
    taskId TEXT PRIMARY KEY, project TEXT NOT NULL, peer TEXT NOT NULL, fp TEXT NOT NULL, branch TEXT NOT NULL, repo TEXT NOT NULL,
    prevAssignee TEXT, prevAssigneeKind TEXT, state TEXT NOT NULL CHECK (state IN ('held','ended')), reason TEXT,
    createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`;

export function LEND_WRITE_SCHEMA(db: Database): void {
  const run = (sql: string) => db.prepare(sql).run();
  const cur = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lend_orders'").get() as { sql: string } | null;
  if (cur && !cur.sql.includes("'write'")) {
    run("DROP TABLE IF EXISTS lend_orders_r6");
    run(ordersTable("lend_orders_r6"));
    run(`INSERT INTO lend_orders_r6 (${T93_COLUMNS}) SELECT ${T93_COLUMNS} FROM lend_orders`);
    run("DROP TABLE lend_orders");
    run("ALTER TABLE lend_orders_r6 RENAME TO lend_orders");
  }
  LEND_SCHEMA(db);
  run(LEASES_SQL);
}

export const LEND_TABLES = ["lend_orders", "lend_write_leases"] as const;
export const LEND_COLUMNS: Record<string, readonly string[]> = {
  lend_orders: ["orderId", "taskId", "project", "peer", "family", "step", "specRev", "round", "head", "repo", "pr", "wire", "text", "sha256", "status",
    "worker", "leaseGen", "leaseMs", "leaseUntil", "resultSha", "receipt", "eventSeq", "reason", "supersedes", "createdBy", "branch", "base"],
  lend_write_leases: ["taskId", "peer", "fp", "branch", "repo", "prevAssignee", "prevAssigneeKind", "state", "reason"],
};
export const LEND_INDEXES: Record<string, readonly string[]> = { lend_orders: ["lend_orders_peer_status", "lend_orders_live"] };
