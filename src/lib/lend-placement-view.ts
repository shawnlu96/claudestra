/**
 * 一张卡的当前节点此刻放哪、为什么（i28-W5 只读投影）：`ledger lend-orders` 与借入面板的远端行（bridge lend-peers-view.ts）
 * 共用这一个函数，所以两边显示的放置结果不会不一致；规则本身在 explainPlacement / placeFor，这里只组装快照输入。
 * borrow 传生效的借入名单；remote.mode = off 时按空名单算（与调度器同口径）。tests/web-borrow-placement.test.ts
 */
import type { Database } from "bun:sqlite";
import type { BorrowEntry } from "./lend-config.js";
import type { LedgerTask } from "./ledger-stages.js";
import { autoSnapshot } from "./scheduler-auto-snapshot.js";
import type { RemotePolicy } from "./scheduler-config.js";
import { explainPlacement } from "./scheduler-placement-plan.js";

export type ProjectPolicy = { remote?: RemotePolicy; maxActiveWorkers: number } | null;

export function placementOf(db: Database, task: LedgerTask, policy: ProjectPolicy, borrow: readonly BorrowEntry[], now: number): ReturnType<typeof explainPlacement> {
  const remote = policy?.remote;
  const pool = remote ? { pool: { remote, borrow: remote.mode !== "off" ? borrow : [] } } : {};
  return explainPlacement(autoSnapshot(db, task, { registry: [], maxWorkers: policy?.maxActiveWorkers ?? 0, now, ...pool }));
}
