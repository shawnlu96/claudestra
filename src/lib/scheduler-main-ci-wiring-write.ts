/** MAINCIW durable writes (scheduler-main-ci-wiring-store.ts has the keys and the reads); called only by manager/ledger-main-ci-cmds.ts. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { WriteCtx } from "./ledger-checks.js";
import { LedgerError } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { getIntent } from "./ledger-scheduler.js";
import { FAILURE_KEY, mainCiLent, NOTIFY_PREFIX, REPAIR_OP, REPAIR_PREFIX, REVOKE_OP, SLOT_OP, UNCERTAINTY_KEY, type MainCiPersisted } from "./scheduler-main-ci-wiring-store.js";

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

const slotOf = (db: Database, project: string) => db.query("SELECT intentId FROM scheduler_resources WHERE project = ? AND resource = ?")
  .get(project, `merge:${project}`) as { intentId: string } | null;
const begun = (db: Database, intentId: string) => !!db.query("SELECT 1 FROM scheduler_merges WHERE intentId = ?").get(intentId);

/** A planned merge intent nothing has begun yet: pending, no merge run, this project. */
function unbegun(db: Database, project: string, intentId: string) {
  const i = getIntent(db, intentId);
  if (!i || i.project !== project || i.action !== "merge" || i.status !== "pending" || begun(db, intentId)) {
    throw new LedgerError("conflict", `${intentId} 不是本项目未开运行的 pending 合并意图`);
  }
  return i;
}

function slotEvent(db: Database, ctx: WriteCtx, project: string, taskId: string, intentId: string, turn: "lend" | "take", why: string): void {
  appendEvent(db, ctx, { project, target: taskId, kind: "note", text: `主线 CI 暂停：${intentId} ${turn === "lend" ? "让出" : "取回"}项目合并槽（${why}）`,
    data: { op: SLOT_OP, intentId, turn, why } });
}

/**
 * Paused, a pending merge intent gives the project slot to a PM-bound repair card (PM 定 2: a paused pending intent holds no slot).
 * Only an unbegun intent holding the slot, and only while some other card of the project has a repair binding on the ledger.
 */
export function lendMainCiSlot(db: Database, ctx: WriteCtx, project: string, intentId: string): void {
  db.transaction(() => {
    const i = unbegun(db, project, intentId);
    if (slotOf(db, project)?.intentId !== intentId) throw new LedgerError("conflict", `${intentId} 未占项目合并槽`);
    if (!db.query(`SELECT 1 FROM events WHERE project = ? AND kind = 'decision' AND target != ? AND json_extract(data, '$.op') = ? LIMIT 1`)
      .get(project, i.taskId, REPAIR_OP)) throw new LedgerError("conflict", "本项目没有别的卡的主线 CI 修复绑定");
    db.run("DELETE FROM scheduler_resources WHERE project = ? AND resource = ? AND intentId = ?", [project, `merge:${project}`, intentId]);
    slotEvent(db, ctx, project, i.taskId, intentId, "lend", "让 PM 绑定的修复卡先合");
  }).immediate();
}

/**
 * The lender takes the slot back before it is claimed: a free slot, or one an unbegun merge intent planned after it holds (that one
 * then lends in turn and takes it back the same way), so cards planned during the pause cannot starve it. Else busy, wait.
 */
export function takeMainCiSlot(db: Database, ctx: WriteCtx, project: string, intentId: string): "taken" | "busy" {
  return db.transaction(() => {
    const i = unbegun(db, project, intentId);
    if (!mainCiLent(db, project, intentId)) throw new LedgerError("conflict", `${intentId} 没有让出过合并槽`);
    const holder = slotOf(db, project), other = holder && getIntent(db, holder.intentId);
    if (holder) {
      if (!other || other.action !== "merge" || other.status !== "pending" || begun(db, other.id) || other.eventSeq <= i.eventSeq) return "busy" as const;
      db.run("DELETE FROM scheduler_resources WHERE project = ? AND resource = ? AND intentId = ?", [project, `merge:${project}`, other.id]);
      slotEvent(db, ctx, project, other.taskId, other.id, "lend", `还给暂停前就排着的 ${intentId}`);
    }
    db.run("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES (?, ?, ?, ?, ?, 'intent')",
      [project, `merge:${project}`, i.taskId, intentId, ctx.now ?? Date.now()]);
    slotEvent(db, ctx, project, i.taskId, intentId, "take", "主线 CI 闸放行");
    return "taken" as const;
  }).immediate();
}
