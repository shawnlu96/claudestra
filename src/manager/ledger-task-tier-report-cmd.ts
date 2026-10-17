/** Read existing usage detail through a read-only connection; the command never creates or migrates either database. */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { taskTierReport, type TierUsage } from "../lib/task-tier-report.js";
import { USAGE_DB_PATH } from "../lib/usage-store.js";
import { LedgerError } from "../lib/ledger-store.js";
import type { LedgerCli, Result } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

export function readTierSessionUsage(db: Database, sessionId: string, start: number, end: number): TierUsage | null {
  const r = db.query(`SELECT COUNT(*) AS calls, SUM(c.input) AS input, SUM(c.cache_creation) AS cacheCreation,
    SUM(c.cache_read) AS cacheRead, SUM(c.output) AS output, SUM(c.reasoning) AS reasoning
    FROM calls c JOIN turns t ON t.turn_id = c.turn_id WHERE t.session_id = ? AND c.ts >= ? AND c.ts < ?`).get(sessionId, start, end) as TierUsage;
  return r.calls ? r : null;
}

function run(c: LedgerCli): Result {
  const project = c.p.pos[1] ?? c.project();
  if (!c.deps.projectIds.includes(project)) throw new LedgerError("not_found", `没有项目 ${project}`);
  const raw = c.p.flags.days ?? "7";
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 365) throw new LedgerError("invalid", "--days 要是 1 到 365 的整数");
  const usage = existsSync(USAGE_DB_PATH) ? new Database(USAGE_DB_PATH, { readonly: true, create: false }) : null;
  try {
    const read = () => taskTierReport(c.db, project, { days: Number(raw), now: c.deps.now(),
      sessionsForCard: usage ? (card: string, start: number, end: number) => (usage.query(`SELECT DISTINCT t.session_id AS id
        FROM turns t JOIN calls c ON c.turn_id = t.turn_id WHERE t.attr_task = ? AND c.ts >= ? AND c.ts < ?`).all(card, start, end) as { id: string }[])
        .map(r => r.id) : undefined,
      readUsage: usage ? (id: string, start: number, end: number) => readTierSessionUsage(usage, id, start, end) : undefined });
    return c.db.transaction(() => usage ? usage.transaction(read)() : read())();
  } finally { usage?.close(); }
}

export const TASK_TIER_REPORT_CMD: CommandSpec = {
  valued: ["days", "project"], usage: "task-tier-report <project> [--days 7]", run,
};
