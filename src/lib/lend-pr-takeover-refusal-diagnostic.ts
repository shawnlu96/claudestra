/** A separate diagnostic writer; never runs inside the rejected takeover write transaction. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { tx } from "./ledger-tx.js";
import { takeoverRefusal } from "./lend-pr-takeover-ledger.js";
import { uiTakeoverRefusal, type UiTakeoverRefusal } from "./lend-pr-takeover-refusal.js";
import { observeDedupKey } from "./recovery-policy.js";

export function takeoverDiagnosticKey(orderId: string, head: string, pr: number | null, r: UiTakeoverRefusal) {
  const { task, code, reason } = r;
  const material = createHash("sha256").update(JSON.stringify([orderId, head, task.specRev, task.round, code, reason, pr])).digest("hex");
  const a = { project: task.project, target: task.id, actionKey: `takeover:${material}` };
  return { ...a, key: observeDedupKey({ ...a, mechanism: "uiDelivery" }) };
}

/** CLI-only narrow writer: it recomputes the refusal, takes the writer lock, then rechecks before the observation. */
export function writeTakeoverRefusal(db: Database, orderId: string, head: string, pr: number | null, r: UiTakeoverRefusal,
  clock: () => number, beforeWrite: () => void): string | null {
  const { task, port, code, reason } = r;
  const { key, ...a } = takeoverDiagnosticKey(orderId, head, pr, r);
  const effect = pr === null ? "本轮代开 PR / 接管未发出；已有外部效果未排除" : `已查到 PR #${pr}；本轮接管未发出`;
  return tx(db, () => {
    beforeWrite();
    if (getEventByDedup(db, key)) return null;
    const why = takeoverRefusal(db, orderId, clock());
    if (why) throw new LedgerError("conflict", why);
    const current = uiTakeoverRefusal(db, orderId, head, () => port);
    if (!current || current.task.rev !== task.rev || current.code !== code || current.reason !== reason) {
      throw new LedgerError("conflict", "接管诊断状态已变化");
    }
    beforeWrite();
    port.observe(db, { ...a, action: `停止出借接管（${code}）`,
      data: { orderId, head, specRev: task.specRev, round: task.round, code, reason, pr, effect, preflight: true } });
    return `${reason}；${effect}`;
  });
}
