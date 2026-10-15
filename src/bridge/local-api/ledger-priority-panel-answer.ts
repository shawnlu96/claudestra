/** Reject priority authorization failures through the shared web/Discord ask error contract. */
import type { Database } from "bun:sqlite";
import type { Ask, AskAnswer } from "../../lib/ledger-asks.js";
import { preparePriorityPanelAnswer as prepare } from "../../lib/ledger-priority-panel-write.js";
import { LedgerError } from "../../lib/ledger-store.js";
type Rejection = new (status: 403 | 409, code: string, message: string) => Error;

export function preparePriorityPanelAnswer(db: Database, ask: Ask, answer: AskAnswer, within: (() => void) | undefined, AskRejected: Rejection): (() => void) | undefined {
  const apply = prepare(db, ask, answer);
  if (!apply) return within;
  return () => {
    try { apply(); }
    catch (error) {
      if (error instanceof LedgerError && error.code === "conflict") {
        throw new AskRejected(409, "priority_conflict", "版本已变，请刷新后重试");
      }
      if (error instanceof LedgerError && error.code === "forbidden") {
        throw new AskRejected(403, "priority_forbidden", error.message);
      }
      throw error;
    }
    within?.();
  };
}
