/** Leaf ports keep QUEUE1's readers out of the merge journal dependency graph. The scheduler writer installs its CAS guards. */
import type * as Owner from "./merge-queue-owner.js";
import type * as Pass from "./merge-queue-owner-pass.js";
import type * as MainCi from "./merge-queue-owner-main-ci.js";
import { getTask, LedgerError } from "./ledger-store.js";
import { queueOwnerMode } from "./merge-queue-owner-context.js";

let writes: { require: typeof Owner.requireMergeQueueOwner; manual: typeof Owner.ownerManualTurn } | undefined;
let pass: { slot: typeof Pass.ownerSlotTurn; mainCi: typeof MainCi.ownerMainCiDecision } | undefined;
export function bindOwnerWrites(port: NonNullable<typeof writes>): void { writes = port; }
export function bindOwnerPass(port: NonNullable<typeof pass>): void { pass = port; }
export function requireMergeQueueOwner(...args: Parameters<typeof Owner.requireMergeQueueOwner>): void {
  const task = getTask(args[0], args[1]);
  if (!task || queueOwnerMode(args[0], task.project) !== "on") return;
  if (!writes) throw new LedgerError("conflict", "统一合并仲裁写口尚未安装");
  writes.require(...args);
}
export function ownerManualTurn(...args: Parameters<typeof Owner.ownerManualTurn>): ReturnType<typeof Owner.ownerManualTurn> {
  if (queueOwnerMode(args[0], args[1]) !== "on") return null;
  if (!writes) throw new LedgerError("conflict", "统一合并仲裁写口尚未安装");
  return writes.manual(...args);
}
export function ownerSlotTurn(...args: Parameters<typeof Pass.ownerSlotTurn>): ReturnType<typeof Pass.ownerSlotTurn> {
  return pass?.slot(...args) ?? Promise.resolve(null);
}
export function ownerMainCiDecision(...args: Parameters<typeof MainCi.ownerMainCiDecision>): ReturnType<typeof MainCi.ownerMainCiDecision> {
  return pass?.mainCi(...args) ?? null;
}
