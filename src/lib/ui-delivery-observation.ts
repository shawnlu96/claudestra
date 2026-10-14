/** Only locally verified success joins uiDelivery observations; peers keep their existing independent observation protocol. */
import { createHash } from "node:crypto";
import type { LedgerTask } from "./ledger-stages.js";
import type { UiEvidence } from "./order-deliver-ui.js";

export interface UiSuccessObservation { code: "ok"; why: string; head: string; round: number; digest: string }

/** Called after the existing strict parser, binding checks, and actual byte verification succeed. */
export function localUiSuccessPlan(e: UiEvidence, isPeer: boolean): { observed?: UiSuccessObservation } {
  return isPeer ? {} : { observed: { code: "ok", why: "本机正规截图清单及实际字节核对通过", head: e.head, round: e.round, digest: e.digest } };
}

/** Hash the full tuple to fit recordObserved's 120-character key bound without truncating head or digest identity. */
export function uiSuccessNote(task: LedgerTask, e: UiSuccessObservation) {
  const key = createHash("sha256").update(JSON.stringify([e.head, e.round, e.digest])).digest("hex");
  return { project: task.project, target: task.id, actionKey: `ui-delivery:ok:${key}`,
    action: "接收 ui 卡交付（截图证据 ok：本机正规清单及实际字节核对通过）",
    data: { code: e.code, head: e.head, round: e.round, digest: e.digest } };
}
