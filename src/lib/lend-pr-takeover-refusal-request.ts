/** Scheduler holds a query-only ledger: diagnostics go through a typed CLI, never writes on that read connection. */
import type { Database } from "bun:sqlite";
import { getEventByDedup } from "./ledger-store.js";
import { takeoverDiagnosticKey } from "./lend-pr-takeover-refusal-diagnostic.js";
import type { UiTakeoverRefusal } from "./lend-pr-takeover-refusal.js";
import { SchedulerLeaseLost } from "./scheduler-lease-env.js";

const attempts = new WeakMap<Database, Map<string, number>>();

/** Persisted success deduplicates across restart; failed CLI/storage gets at most three attempts per process/material. */
export async function requestTakeoverRefusal(db: Database, orderId: string, head: string, pr: number | null, r: UiTakeoverRefusal,
  manager: (...args: string[]) => Promise<Record<string, unknown>>): Promise<string | null> {
  const { key } = takeoverDiagnosticKey(orderId, head, pr, r);
  if (getEventByDedup(db, key)) return null;
  let tries = attempts.get(db);
  if (!tries) { tries = new Map(); attempts.set(db, tries); }
  const n = tries.get(key) ?? 0;
  const effect = pr === null ? "本轮代开 PR / 接管未发出，既有外部效果未排除" : `已查到 PR #${pr}，本轮接管未发出`;
  if (n >= 3) return `${r.reason}；诊断已停止重试（3/3）；${effect}`;
  tries.set(key, n + 1);
  const args = ["ledger", "lend-takeover-refusal", orderId, "--head", head, ...(pr === null ? [] : ["--pr", String(pr)])];
  const out = await manager(...args);
  if (out.code === "lease-lost") throw new SchedulerLeaseLost(`接管诊断失租：${String(out.error ?? "lease lost")}`);
  return out.ok === true ? (typeof out.message === "string" ? out.message : null)
    : `${r.reason}；${effect}；诊断写失败（${n + 1}/3）：${String(out.error ?? "manager failed")}`;
}
