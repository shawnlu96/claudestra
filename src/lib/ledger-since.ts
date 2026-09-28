/**
 * 协作视图「上次以来」的原料（T12c）：某时刻之后本项目任务上发生的、值得在首页摘要里说一句的事件。
 * 只挑推进 / 审查 / 上线 / 验证 / 回滚 / 新派发；导入推断时间的事件不算（那是回填的历史，不是「你离开期间」发生的）。
 * 过滤全在 SQL 里做完再 LIMIT，truncated 才说得准「是不是没列全」。text 只留首行、按码点截 120，data 只留摘要要的几个键。
 */
import type { Database } from "bun:sqlite";
import { clipFirstLine } from "./ledger-read.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { toEvent } from "./ledger-store.js";

/** 摘要最多用 5 条，这里多给一些：同一任务的多次推进要合并，挑最重要的那件 */
export const SINCE_EVENTS_LIMIT = 200;
const KINDS = ["stage", "review", "verify", "deploy", "rollback", "task"] as const;
const DATA_KEYS = ["from", "to", "round", "verdict", "p0", "p1", "p2", "result", "version", "op"] as const;

/** (since, until] 之间的事件，seq 升序；超过上限时留最新的 SINCE_EVENTS_LIMIT 条并标 truncated */
export function sinceEvents(db: Database, project: string, since: number, until: number = Number.MAX_SAFE_INTEGER): { events: LedgerEvent[]; truncated: boolean } {
  const rows = db
    .query(
      `SELECT * FROM events WHERE project = ? AND target != '' AND ts > ? AND ts <= ? AND kind IN (${KINDS.map(() => "?").join(", ")})
         AND json_valid(data) AND COALESCE(json_extract(data, '$.approxTime'), 0) != 1
         AND (kind != 'task' OR json_extract(data, '$.op') = 'new')
       ORDER BY seq DESC LIMIT ?`,
    )
    .all(project, since, until, ...KINDS, SINCE_EVENTS_LIMIT + 1) as Record<string, unknown>[];
  const events = rows.slice(0, SINCE_EVENTS_LIMIT).map((r) => {
    const e = toEvent(r);
    const data: Record<string, unknown> = {};
    for (const k of DATA_KEYS) if (k in e.data) data[k] = e.data[k];
    return { ...e, text: clipFirstLine(e.text), data };
  });
  return { events: events.reverse(), truncated: rows.length > SINCE_EVENTS_LIMIT };
}
