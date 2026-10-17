/**
 * 每卡事实表（agents-LEDGERFAST1，PM 补 10-17 22:5x 选 B）：已结束卡的完成时刻、审查计数、产品板要 find 的阶段标记，
 * 按 (数据库实例, project, target, 该卡最大 seq) 记住。最大 seq 走 (project, target, seq) 覆盖索引取，O(log n)；
 * events 有 events_no_update / events_no_delete 触发器只能追加，键不变结果就不变，只有来了新事件的卡才重读。
 * 于是稳态下每次请求的工作量随卡数涨、不随历史涨；冷启动那一次逐卡读一遍，随历史线性。
 * 这不是整页构建缓存（那是 BOARDMEM1 的 board-build-cache），只记卡级派生事实。
 */
import type { Database } from "bun:sqlite";
import type { LedgerEvent } from "./ledger-stages.js";
import { toEvent } from "./ledger-store.js";

/** 每个库句柄最多记这么多张卡，超了淘汰最久没用的 */
const CARD_FACTS_MAX = 20_000;

export interface CardFacts {
  /** 每个结束阶段第一次且不早于开工时刻的进入时刻（ledger-metrics.ts timeMetrics 的 endTs 口径） */
  ends: Map<unknown, number>;
  /** review 事件数与 P0 / P1 合计（taskMetrics 口径：data 里是有限数字才计） */
  reviews: { n: number; p0: number; p1: number };
  /** 时间线上第一次进 build / verified / done / cancelled 的那几条事件，seq 升序（产品板只 find 这几段） */
  marks: LedgerEvent[];
}

interface Entry {
  maxSeq: number;
  facts: CardFacts;
}

const memo = new WeakMap<Database, Map<string, Entry>>();

const MAX_SEQ = "SELECT MAX(seq) AS m FROM events WHERE project = ?1 AND target = ?2";
/** 只取时间线取点（建任务、stage）和 review；走 (project, target, seq) 索引 */
const CARD_ROWS = `SELECT * FROM events WHERE project = ?1 AND target = ?2
  AND (kind IN ('stage', 'review') OR (kind = 'task' AND json_extract(data, '$.op') = 'new')) ORDER BY seq`;

/** 停在这些阶段不算开工（ledger-metrics.ts NOT_STARTED） */
const NOT_STARTED: readonly unknown[] = ["spec", "blocked", "cancelled"];
const END: readonly unknown[] = ["verified", "done", "cancelled"];
const MARK: readonly unknown[] = ["build", "verified", "done", "cancelled"];
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** 时间线取点的阶段（ledger-metrics.ts stageTimeline）：stage 取 data.to，建任务取 patch.stage（缺省 spec） */
function stageOf(e: LedgerEvent): unknown {
  return e.kind === "stage" ? e.data.to : ((e.data.patch ?? {}) as { stage?: unknown }).stage ?? "spec";
}

function compute(rows: readonly LedgerEvent[]): CardFacts {
  const reviews = { n: 0, p0: 0, p1: 0 };
  const points: { e: LedgerEvent; st: unknown }[] = [];
  for (const e of rows) {
    if (e.kind === "review") {
      reviews.n++;
      reviews.p0 += count(e.data.p0);
      reviews.p1 += count(e.data.p1);
    } else points.push({ e, st: stageOf(e) });
  }
  const startTs = points.find((p) => !NOT_STARTED.includes(p.st))?.e.ts ?? null;
  const ends = new Map<unknown, number>();
  for (const p of points) if (END.includes(p.st) && !ends.has(p.st) && (startTs === null || p.e.ts >= startTs)) ends.set(p.st, p.e.ts);
  const seen = new Set<unknown>();
  const marks = points.filter((p) => MARK.includes(p.st) && !seen.has(p.st) && seen.add(p.st)).map((p) => p.e);
  return { ends, reviews, marks };
}

/** 这几张卡的事实；只重读最大 seq 变了（或没记过）的卡。调用方包在同一个读事务里 */
export function cardFacts(db: Database, project: string, ids: readonly string[]): Map<string, CardFacts> {
  let table = memo.get(db);
  if (!table) memo.set(db, (table = new Map()));
  const maxOf = db.query(MAX_SEQ), rowsOf = db.query(CARD_ROWS);
  const out = new Map<string, CardFacts>();
  for (const id of ids) {
    const key = `${project}\0${id}`;
    const maxSeq = (maxOf.get(project, id) as { m: number | null }).m ?? 0;
    let entry = table.get(key);
    if (entry && entry.maxSeq === maxSeq) table.delete(key);
    else entry = { maxSeq, facts: compute((rowsOf.all(project, id) as Record<string, unknown>[]).map(toEvent)) };
    table.set(key, entry);
    out.set(id, entry.facts);
  }
  for (const key of table.keys()) {
    if (table.size <= CARD_FACTS_MAX) break;
    table.delete(key);
  }
  return out;
}
