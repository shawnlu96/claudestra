/** Scheduler holds a query-only ledger: diagnostics go through a typed CLI, never writes on that read connection. */
import type { Database } from "bun:sqlite";
import { getEventByDedup } from "./ledger-store.js";
import { takeoverDiagnosticKey } from "./lend-pr-takeover-refusal-diagnostic.js";
import type { UiTakeoverRefusal } from "./lend-pr-takeover-refusal.js";

const attempts = new WeakMap<Database, Map<string, number>>();

/** Persisted success deduplicates across restart; failed CLI/storage gets at most three attempts per process/material. */
export async function requestTakeoverRefusal(db: Database, orderId: string, head: string, pr: number | null, r: UiTakeoverRefusal,
  manager: (...args: string[]) => Promise<Record<string, unknown>>): Promise<string | null> {
  const { key } = takeoverDiagnosticKey(orderId, head, pr, r);
  if (getEventByDedup(db, key)) return null;
  let tries = attempts.get(db);
  if (!tries) { tries = new Map(); attempts.set(db, tries); }
  const n = tries.get(key) ?? 0;
  if (n >= 3) return null;
  tries.set(key, n + 1);
  const args = ["ledger", "lend-takeover-refusal", orderId, "--head", head, ...(pr === null ? [] : ["--pr", String(pr)])];
  const out = await manager(...args);
  return out.ok === true ? (typeof out.message === "string" ? out.message : null)
    : `UI 接管已停止；诊断写失败（${n + 1}/3）：${String(out.error ?? "manager failed")}`;
}
