/**
 * lend_orders（T93，docs/design/remote-capacity.md §2.2、§6）：一张卡挂进出借池的那一单，本身就是出借意图——
 * 不复用 scheduler_intents：那张表的状态 CHECK 没有 pooled，planIntent 只收自动流程的卡，自动 tick 会取消没绑 session 的 pending。
 * 状态：pooled（等人领）→ claimed（某个 peer 持有租约）→ done（结论已入账）| unknown（租约过期 / 对方报停，交 PM）|
 * cancelled（PM 撤单或重挂）| released（对方报 worker 从没起过）。一张卡同时最多一单未结（部分唯一索引）。
 * 迁移规矩同 ledger-store.ts：一条语句一次 prepare().run()，每步可重跑。tests/ledger-lend.test.ts。
 */
import type { Database } from "bun:sqlite";

const LEND_ORDER_STATUSES = ["pooled", "claimed", "done", "unknown", "cancelled", "released"] as const;
export type LendOrderStatus = (typeof LEND_ORDER_STATUSES)[number];
/** 未结 = 还挡着这张卡再挂一单，也是 peer-ledger 拒写（lend_managed）的判据之一 */
export const LEND_LIVE: readonly LendOrderStatus[] = ["pooled", "claimed", "unknown"];

const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

const LEND_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS lend_orders (
    orderId TEXT PRIMARY KEY, taskId TEXT NOT NULL, project TEXT NOT NULL, peer TEXT NOT NULL,
    family TEXT NOT NULL CHECK (family IN ('codex','claude')), step TEXT NOT NULL CHECK (step IN ('review')),
    specRev INTEGER NOT NULL, round INTEGER NOT NULL, head TEXT NOT NULL, repo TEXT NOT NULL, pr INTEGER,
    wire TEXT NOT NULL, text TEXT NOT NULL, sha256 TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (${inList(LEND_ORDER_STATUSES)})),
    worker TEXT, leaseGen INTEGER NOT NULL DEFAULT 0, leaseMs INTEGER NOT NULL, leaseUntil INTEGER,
    resultSha TEXT, receipt TEXT, eventSeq INTEGER, reason TEXT, supersedes TEXT,
    createdBy TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS lend_orders_peer_status ON lend_orders(peer, status)",
  `CREATE UNIQUE INDEX IF NOT EXISTS lend_orders_live ON lend_orders(taskId) WHERE status IN (${inList(LEND_LIVE)})`,
];

export function LEND_SCHEMA(db: Database): void {
  for (const sql of LEND_SQL) db.prepare(sql).run();
}

export const LEND_TABLES = ["lend_orders"] as const;
export const LEND_COLUMNS: Record<string, readonly string[]> = {
  lend_orders: ["orderId", "taskId", "project", "peer", "family", "step", "specRev", "round", "head", "repo", "pr", "wire", "text", "sha256", "status",
    "worker", "leaseGen", "leaseMs", "leaseUntil", "resultSha", "receipt", "eventSeq", "reason", "supersedes", "createdBy"],
};
export const LEND_INDEXES: Record<string, readonly string[]> = { lend_orders: ["lend_orders_peer_status", "lend_orders_live"] };
