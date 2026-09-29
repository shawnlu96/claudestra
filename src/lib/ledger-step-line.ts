/**
 * 协作视图的步骤线（T51）：总览的每张卡和任务详情都带一份——库里的步骤行加推出来的（withDerived）、当前在干活的那一步
 * （stepAtStage，和权限判定同一口径），以及是不是在等对方 owner 同意（卡在 spec、当前这一步派给了别的实例、那个实例还没有
 * accept 事件；进了 restate 就算接下了）。peer 从当前这一步取，老卡推出来的步骤也带 delegate，只认同一个 peer 的 accept——
 * 审查 peer 先接不能替写的 peer 清掉等待。只进本机管理面（local-api/ledger.ts 的 projectView / taskDetail），peer 读卡走 peer-ledger.ts
 * 自己的白名单，不经这里。tests/ledger-step-line.test.ts。
 */
import type { LedgerEvent, LedgerTask, StepName } from "./ledger-stages.js";
import { stepAtStage, stepPeer, withDerived, type TaskStep } from "./ledger-steps.js";

export interface StepLineInfo {
  steps: TaskStep[];
  /** 当前阶段在干活的那一步（blocked 看 stageBefore）；没人 = null */
  active: { step: StepName; round: number } | null;
  /** 委托给别的实例、对方 owner 还没点头 */
  awaitingPeerOwner: boolean;
}

export function stepLineInfo(task: LedgerTask, rows: readonly TaskStep[], events: readonly LedgerEvent[]): StepLineInfo {
  const steps = withDerived(task, [...rows]);
  const a = stepAtStage(steps, task);
  const peer = task.stage === "spec" && a ? stepPeer(a) : null;
  const awaitingPeerOwner = !!peer && !events.some((e) => e.kind === "accept" && e.data.peer === peer);
  return { steps, active: a ? { step: a.step, round: a.round } : null, awaitingPeerOwner };
}
