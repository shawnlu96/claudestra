/**
 * 每卡事实表（agents-LEDGERFAST1，PM 补 10-17 22:5x 选 B）：已结束卡的完成时刻、审查计数、产品板要 find 的阶段标记，
 * 按 (数据库实例, project, target, 该卡最大 seq) 记住。最大 seq 走 (project, target, seq) 覆盖索引取，O(log n)；
 * events 有 events_no_update / events_no_delete 触发器只能追加，键不变结果就不变，只有来了新事件的卡才重读。
 * 于是稳态下每次请求的工作量随卡数涨、不随历史涨；冷启动那一次逐卡读一遍，随历史线性。
 * 这不是整页构建缓存（那是 BOARDMEM1 的 board-build-cache），只记卡级派生事实。
 */
import type { Database } from "bun:sqlite";
import { stageTimeline, taskMetrics, type TaskMetrics } from "./ledger-metrics.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { toEvent } from "./ledger-store.js";

/** 每个库句柄最多记这么多张卡，超了淘汰最久没用的 */
const CARD_FACTS_MAX = 20_000;

export interface CardFacts {
  /** 完成时刻与审查计数：直接用 ledger-metrics.ts taskMetrics 算（只喂取点和 review 两类事件，这几项只看它们） */
  metrics: Pick<TaskMetrics, "endTs" | "reviewRounds" | "p0" | "p1">;
  /** 时间线上第一次进 build / verified / done / cancelled 的那几条事件，seq 升序（产品板只 find 这几段） */
  marks: LedgerEvent[];
}

interface Entry {
  maxSeq: number;
  /** endTs 按 kind 取结束阶段，kind 改了也重算 */
  kind: LedgerTask["kind"];
  facts: CardFacts;
}

const memo = new WeakMap<Database, Map<string, Entry>>();

const MAX_SEQ = "SELECT MAX(seq) AS m FROM events WHERE project = ?1 AND target = ?2";
/** 只取时间线取点（建任务、stage）和 review；走 (project, target, seq) 索引 */
const CARD_ROWS = `SELECT * FROM events WHERE project = ?1 AND target = ?2
  AND (kind IN ('stage', 'review') OR (kind = 'task' AND json_extract(data, '$.op') = 'new')) ORDER BY seq`;

const MARK: readonly unknown[] = ["build", "verified", "done", "cancelled"];

function compute(card: Pick<LedgerTask, "id" | "kind">, rows: readonly LedgerEvent[]): CardFacts {
  // now 只影响各段的离开时刻，endTs / 审查计数与它无关
  const { endTs, reviewRounds, p0, p1 } = taskMetrics(card, rows, 0);
  // 不是 review 的行就是 stageTimeline 的取点，与时间线逐段对齐
  const points = rows.filter((e) => e.kind !== "review"), seen = new Set<unknown>();
  const marks = stageTimeline(points, 0).flatMap((s, i) => (MARK.includes(s.stage) && !seen.has(s.stage) && seen.add(s.stage) ? [points[i]] : []));
  return { metrics: { endTs, reviewRounds, p0, p1 }, marks };
}

/** 这几张卡的事实；只重读最大 seq 变了（或没记过）的卡。调用方包在同一个读事务里 */
export function cardFacts(db: Database, project: string, cards: readonly Pick<LedgerTask, "id" | "kind">[]): Map<string, CardFacts> {
  let table = memo.get(db);
  if (!table) memo.set(db, (table = new Map()));
  const maxOf = db.query(MAX_SEQ), rowsOf = db.query(CARD_ROWS);
  const out = new Map<string, CardFacts>();
  for (const card of cards) {
    const { id, kind } = card, key = `${project}\0${id}`;
    const maxSeq = (maxOf.get(project, id) as { m: number | null }).m ?? 0;
    let entry = table.get(key);
    if (entry && entry.maxSeq === maxSeq && entry.kind === kind) table.delete(key);
    else entry = { maxSeq, kind, facts: compute(card, (rowsOf.all(project, id) as Record<string, unknown>[]).map(toEvent)) };
    table.set(key, entry);
    out.set(id, entry.facts);
  }
  for (const key of table.keys()) {
    if (table.size <= CARD_FACTS_MAX) break;
    table.delete(key);
  }
  return out;
}
