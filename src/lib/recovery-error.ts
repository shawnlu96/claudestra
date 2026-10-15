/** Optional structured error evidence, deduplicated per project / mechanism / action. */
import type { Database } from "bun:sqlite";
import { textOneLine } from "./ledger-scheduler-settle.js";
import { LedgerError } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { RECOVERY_KEYS, type RecoveryKey } from "./recovery-policy.js";

export function recordRecoveryError(db: Database, input: { project: string; mechanism: RecoveryKey; actionKey: string; error: unknown }, now = Date.now()) {
  if (!(RECOVERY_KEYS as readonly string[]).includes(input.mechanism)) throw new LedgerError("invalid", `未知恢复键 ${input.mechanism}`);
  const actionKey = textOneLine(input.actionKey, "actionKey", 120);
  const error = textOneLine(String(input.error instanceof Error ? input.error.message : input.error), "错误", 600);
  const r = appendEvent(db, { actor: "scheduler", now, dedupKey: `recovery-error:${JSON.stringify([input.project, input.mechanism, actionKey])}` },
    { project: input.project, target: "", kind: "note", text: `恢复错误（${input.mechanism}）：${error}`,
      data: { op: "recovery_error", mechanism: input.mechanism, actionKey, error } });
  return { recorded: !r.duplicate, seq: r.event.seq };
}
