/**
 * A `manager create` that failed and reports its own residue fully cleared (structured `cleanedUp`, not the error text),
 * with no registry row left under the name, built nothing: the scheduler cancels the intent and re-plans after a backoff
 * (2 → 4 → 8 → 15 min, per card and role) instead of stopping as "unknown" for PM. Anything less certain stays unknown.
 * tests/scheduler-create-retry.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import type { RegistryRow } from "./scheduler-auto-ports.js";
import type { SessionRole } from "./scheduler-sessions.js";
import type { EnsureResult } from "./worker-session.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;

export const CREATE_RETRY_BASE_MS = 120_000, CREATE_RETRY_CAP_MS = 900_000, CREATE_RETRY_LOUD = 6;
/** The cancelled receipt is `未建：<reason>` (scheduler-auto-tick.ts ensure); the streak is read back by this prefix. */
const MARK = "建会话失败，现场已清理";
const RECEIPT = `未建：${MARK}`;
/** Steps of clearCreateResidue that leave nothing behind; any other (window kept, channel unknown, old row restored) is not clean. */
const CLEAN_STEPS = new Set(["窗口已关", "频道已删", "频道早已不在", "占位已删"]);

/** The `cleanedUp` flag of manager create's failure output (src/manager.ts cleanup). */
export const createCleanedUp = (r: { ok: boolean; steps: string[] }): boolean =>
  r.ok && r.steps.includes("占位已删") && r.steps.every((s) => CLEAN_STEPS.has(s));

export const createRetryDelay = (n: number): number => Math.min(CREATE_RETRY_BASE_MS * 2 ** (Math.max(n, 1) - 1), CREATE_RETRY_CAP_MS);

/** Consecutive clean create failures of this card's role, newest first; any other settled ensure_session ends the streak. */
function streak(db: Database, taskId: string, role: SessionRole): { n: number; last: number } {
  const rows = db.query(`SELECT receipt, updatedAt FROM scheduler_intents WHERE taskId = ? AND action = 'ensure_session'
    AND (node = 'adversarial_review') = ? AND status NOT IN ('pending','submitted') ORDER BY eventSeq DESC LIMIT 100`)
    .all(taskId, role === "reviewer" ? 1 : 0) as { receipt: string | null; updatedAt: number }[];
  const n = rows.findIndex((r) => !r.receipt?.startsWith(RECEIPT));
  return { n: n === -1 ? rows.length : n, last: rows[0]?.updatedAt ?? 0 };
}

/** Planner gate: while the backoff of the last clean failure runs, the same ensure_session is not planned again. */
export function createRetryBackoff(db: Database, taskId: string, role: SessionRole, now: number): string | null {
  const { n, last } = streak(db, taskId, role);
  if (!n) return null;
  const left = last + createRetryDelay(n) - now;
  return left > 0 ? `建 ${role} 会话连续 ${n} 次失败（现场已清理），${Math.ceil(left / 1000)}s 后重试` : null;
}

/** manager create keys the registry by `agent-<name>` lowercased (normalizeName in src/manager/core.ts, not importable here). */
const registryName = (raw: string): string => `agent-${raw.replace("agent-", "").toLowerCase()}`;

/**
 * Run one ensure with its creates watched. Only an "unknown" whose create itself failed clean, with the name absent from
 * the registry, turns into "wait"; a create that succeeded (e.g. no session id within 90 s) or anything else passes through.
 */
export async function retryCleanCreate(env: { db: Database; registryRow: RegistryRow; create: Manager }, task: LedgerTask, role: SessionRole,
  run: (create: Manager) => Promise<EnsureResult>, now: () => number = Date.now): Promise<EnsureResult> {
  let failed: { r: Record<string, unknown>; name: string } | null = null;
  const got = await run(async (...args) => {
    const r = await env.create(...args);
    if (args[0] === "create") failed = r.ok === true ? null : { r, name: registryName(args[1] ?? "") };
    return r;
  });
  const f = failed as { r: Record<string, unknown>; name: string } | null;
  if (got.kind !== "unknown" || !f || f.r.cleanedUp !== true || env.registryRow(f.name)) return got;
  const n = streak(env.db, task.id, role).n + 1, wait = createRetryDelay(n);
  const first = String(f.r.error ?? "").split("\n")[0].trim().slice(0, 240);
  const loud = n >= CREATE_RETRY_LOUD ? `，⚠ 已连续失败 ${n} 次，请 PM 留意（仍自动重试）` : "";
  return { kind: "wait", reason: `${MARK}（${role} ${f.name} 第 ${n} 次${loud}；${wait / 60_000} 分钟后、最早 ${new Date(now() + wait).toISOString()} 重试）：${first}` };
}
