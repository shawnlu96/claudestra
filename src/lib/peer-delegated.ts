/**
 * 本方台账里这张卡是不是委托给了这个 peer（T48 增补 2）：peer 发回 `[协作 Txx/<步骤>]` 时，这是对方在回报我们委托出去的那一步，
 * 不是新委托，注入头不该要求先问 owner（bridge/router.ts collabNote）。按步骤判：任何一步（含老卡按 extra.delegate / reviewer 推出的）
 * 派给了这个 peer 就算。只读：bridge 这边用 LedgerReader，库还没建或读不到一律 false（退回原来的判定，最多多问一次 owner）。
 */
import type { Database } from "bun:sqlite";
import { LedgerReader } from "./ledger-read.js";
import { getTask } from "./ledger-store.js";
import { stepPeer, stepsOf } from "./ledger-steps.js";

const reader = new LedgerReader();

export function isTaskDelegatedToPeer(peer: string, taskId: string, db: Database | null = reader.get()): boolean {
  if (!db) return false;
  try {
    const task = getTask(db, taskId);
    return !!task && stepsOf(db, task).some((s) => stepPeer(s) === peer);
  } catch (e) {
    console.warn(`[peer-delegated] 读台账失败，按新委托处理: ${(e as Error).message}`);
    return false;
  }
}
