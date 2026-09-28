/**
 * 协作视图「上次以来」的原料（T12c）：某时刻之后本项目任务上发生的、值得在首页摘要里说一句的事件。
 * 只挑推进 / 审查 / 上线 / 验证 / 回滚 / 新派发；导入推断时间的事件不算（那是回填的历史，不是「你离开期间」发生的）。
 * text 只留首行、按码点截 120，data 只留摘要要的几个键——总览会下发给网页，不必整段带出去。
 */
import type { Database } from "bun:sqlite";
import { clipFirstLine } from "./ledger-read.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { toEvent } from "./ledger-store.js";

/** 摘要最多用 5 条，这里多给一些：同一任务的多次推进要合并，挑最重要的那件 */
export const SINCE_EVENTS_LIMIT = 200;
const KINDS = ["stage", "review", "verify", "deploy", "rollback", "task"] as const;
const DATA_KEYS = ["from", "to", "round", "verdict", "p0", "p1", "p2", "result", "version", "op"] as const;

export function sinceEvents(db: Database, project: string, since: number): LedgerEvent[] {
  const rows = db
    .query(
      `SELECT * FROM events WHERE project = ? AND target != '' AND ts > ? AND kind IN (${KINDS.map(() => "?").join(", ")})
       ORDER BY seq DESC LIMIT ?`,
    )
    .all(project, since, ...KINDS, SINCE_EVENTS_LIMIT * 2) as Record<string, unknown>[];
  const out: LedgerEvent[] = [];
  for (const e of rows.map(toEvent)) {
    if (e.data.approxTime === true) continue;
    if (e.kind === "task" && e.data.op !== "new") continue;
    const data: Record<string, unknown> = {};
    for (const k of DATA_KEYS) if (k in e.data) data[k] = e.data[k];
    out.push({ ...e, text: clipFirstLine(e.text), data });
    if (out.length >= SINCE_EVENTS_LIMIT) break;
  }
  return out.reverse();
}
