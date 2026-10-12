/** MAINCIW durable writes (scheduler-main-ci-wiring-store.ts has the keys and the reads); called only by manager/ledger-main-ci-cmds.ts. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { WriteCtx } from "./ledger-checks.js";
import { LedgerError } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { FAILURE_KEY, NOTIFY_PREFIX, REPAIR_OP, REPAIR_PREFIX, REVOKE_OP, UNCERTAINTY_KEY, type MainCiPersisted } from "./scheduler-main-ci-wiring-store.js";

/** CLI side (scheduler identity only): both keys in one transaction; null deletes the key. */
export function writeMainCiState(db: Database, project: string, s: MainCiPersisted): void {
  db.transaction(() => {
    for (const [key, value] of [[FAILURE_KEY, s.readFailureSince], [UNCERTAINTY_KEY, s.uncertainty]] as const) {
      if (value === null) db.run("DELETE FROM meta WHERE project = ? AND key = ?", [project, key]);
      else db.run("INSERT INTO meta (project, key, value) VALUES (?, ?, ?) ON CONFLICT (project, key) DO UPDATE SET value = excluded.value",
        [project, key, JSON.stringify(value)]);
    }
  }).immediate();
}

/** The atomic claim: the UNIQUE dedupKey makes exactly one of several writers (two processes, a restart) see `claimed`. */
export function claimMainCiNotice(db: Database, ctx: WriteCtx, project: string, key: string, kind: string, mainSha: string | null): boolean {
  if (!key || key.length > 400 || /[\p{Cc}\p{Cf}]/u.test(key)) throw new LedgerError("invalid", "通知键无效");
  const r = appendEvent(db, { ...ctx, dedupKey: `${NOTIFY_PREFIX}${key}` }, { project, target: "", kind: "note",
    text: `主线 CI 通知已领取（${kind}${mainSha ? `，main ${mainSha.slice(0, 12)}` : ""}）`, data: { op: "main_ci_notify", key, kind, mainSha } });
  return !r.duplicate;
}

export function recordMainCiRepair(db: Database, ctx: WriteCtx, input: { project: string; taskId: string; head: string; mainSha: string; faultKey: string; reason: string }) {
  const digest = createHash("sha256").update(input.faultKey).digest("hex").slice(0, 16);
  // generation = the card's latest revoke: a retry of the same request replays its event, a binding after a revoke is a new event
  // (mainCiApprovals drops every approval before a revoke, so replaying the pre-revoke one would bind nothing)
  const gen = (db.query(`SELECT MAX(seq) AS seq FROM events WHERE project = ? AND target = ? AND kind = 'decision'
    AND json_extract(data, '$.op') = ?`).get(input.project, input.taskId, REVOKE_OP) as { seq: number | null } | null)?.seq ?? 0;
  const dedupKey = `${REPAIR_PREFIX}${input.taskId}:${input.head.toLowerCase()}:${input.mainSha.toLowerCase()}:${digest}${gen ? `:r${gen}` : ""}`;
  return appendEvent(db, { ...ctx, dedupKey }, { project: input.project, target: input.taskId, kind: "decision",
    text: `主线 CI 修复绑定：head ${input.head.slice(0, 12)}，main ${input.mainSha.slice(0, 12)}（${input.reason}）`,
    data: { op: REPAIR_OP, taskId: input.taskId, head: input.head.toLowerCase(), mainSha: input.mainSha.toLowerCase(), faultKey: input.faultKey, reason: input.reason } });
}

export function revokeMainCiRepair(db: Database, ctx: WriteCtx, input: { project: string; taskId: string; reason: string }) {
  return appendEvent(db, ctx, { project: input.project, target: input.taskId, kind: "decision", text: `撤销主线 CI 修复绑定（${input.reason}）`,
    data: { op: REVOKE_OP, taskId: input.taskId, reason: input.reason } });
}
