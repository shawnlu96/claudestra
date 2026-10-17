/**
 * 总览 / 已完成分页 / 产品板的收窄读法（agents-LEDGERFAST1）：不再把整个项目的事件逐条读进 JS，耗时跟着要显示的卡涨、不跟着历史涨。
 * - 已完成卡的排序与窗口外计数只要完成时刻和审查计数：SQL 里 GROUP BY / MIN 聚合成每卡一两行（doneFacts）。
 * - 要显示的卡再走 (project, target, seq) 索引逐卡取全部事件（eventsOf）和步骤（stepsOf）。
 * - 产品板只用到每卡几条事件（首次进某阶段、最后一个阶段标记、最后一次派活、最新一条），按卡挑出这几条原样读（productEvents）。
 * 输出与逐条读全部事件逐字节相同：tests/ledger-fast-equiv.test.ts 拿旧读法对照。
 */
import type { Database } from "bun:sqlite";
import { blockedBy, type DepView } from "./ledger-deps.js";
import type { DoneFact } from "./ledger-read-done.js";
import { endStages, type LedgerEvent, type LedgerTask } from "./ledger-stages.js";
import { listSteps, type TaskStep } from "./ledger-steps.js";
import { listEvents, toEvent } from "./ledger-store.js";

/**
 * 聚合只扫一遍表、按 rowid 顺读（NOT INDEXED）：走 (project, target, seq) 索引会对每条事件回表随机读，16 万条要 100ms+，顺读一遍只要十几 ms。
 * 阶段时间线的取点（ledger-metrics.ts stageTimeline）：stage 事件取 data.to，建任务事件取 patch.stage（缺省 spec）；
 * data.to 缺省时 st 为 NULL，与 JS 里 undefined 一样不等于任何阶段名。
 */
const ST = "CASE kind WHEN 'stage' THEN json_extract(data, '$.to') ELSE COALESCE(json_extract(data, '$.patch.stage'), 'spec') END";
const IS_MARK = "(kind = 'stage' OR (kind = 'task' AND json_extract(data, '$.op') = 'new'))";
/** taskMetrics 的 p0 / p1：data 里是数字才计 */
const num = (k: string) => `CASE WHEN json_type(data, '$.${k}') IN ('integer', 'real') THEN json_extract(data, '$.${k}') ELSE 0 END`;

/**
 * 一遍扫出两种行：
 * - 每卡每个结束阶段第一次（seq 最小）且不早于开工时刻的进入时刻（n 为 NULL），与 ledger-metrics.ts timeMetrics 的 endTs 同一口径：
 *   开工 = 第一个不是 spec / blocked / cancelled 的取点；没开工则不限时刻。SQLite 的 MIN() 同行取裸列 ts。
 * - 每卡的审查轮数与 P0 / P1 合计（taskMetrics：review 事件数）。
 */
const DONE_FACTS = `WITH r AS MATERIALIZED (
    SELECT target, seq, ts, kind, CASE WHEN kind = 'review' THEN NULL ELSE ${ST} END AS st, ${num("p0")} AS p0, ${num("p1")} AS p1
    FROM events NOT INDEXED WHERE project = ?1 AND (kind = 'review' OR ${IS_MARK})),
  m AS (SELECT target, seq, ts, st FROM r WHERE kind != 'review'),
  s AS (SELECT target, ts AS startTs, MIN(seq) FROM m WHERE st IS NULL OR st NOT IN ('spec', 'blocked', 'cancelled') GROUP BY target)
  SELECT target, st, ts, n, p0, p1 FROM (SELECT m.target AS target, m.st AS st, m.ts AS ts, NULL AS n, NULL AS p0, NULL AS p1, MIN(m.seq)
    FROM m LEFT JOIN s ON s.target = m.target WHERE m.st IN ('verified', 'done', 'cancelled') AND (s.startTs IS NULL OR m.ts >= s.startTs) GROUP BY m.target, m.st)
  UNION ALL SELECT target, NULL, NULL, COUNT(*), SUM(p0), SUM(p1) FROM r WHERE kind = 'review' GROUP BY target`;

/** 已完成卡的窗口 / 分页 / 聚合只要的几样（ledger-read-done.ts doneWindow）：完成时刻和审查计数来自 SQL 聚合，不读事件明细 */
export function doneFacts(db: Database, project: string, done: readonly LedgerTask[], deps: readonly DepView[]): DoneFact[] {
  const ends = new Map<string, Map<unknown, number>>();
  const reviews = new Map<string, { n: number; p0: number; p1: number }>();
  for (const r of db.query(DONE_FACTS).all(project) as { target: string; st: unknown; ts: number; n: number | null; p0: number; p1: number }[]) {
    if (r.n !== null) reviews.set(r.target, { n: r.n, p0: r.p0, p1: r.p1 });
    else ends.set(r.target, (ends.get(r.target) ?? new Map<unknown, number>()).set(r.st, r.ts));
  }
  return done.map((t) => {
    const end = ends.get(t.id);
    const r = reviews.get(t.id);
    return {
      id: t.id, stage: t.stage, kind: t.kind, itemId: t.itemId, updatedAt: t.updatedAt, blockedBy: blockedBy(t.id, deps).map((d) => d.from),
      metrics: { endTs: endStages(t.kind).map((s) => end?.get(s)).find((ts) => ts !== undefined) ?? null, reviewRounds: r?.n ?? 0, p0: r?.p0 ?? 0, p1: r?.p1 ?? 0 },
    };
  });
}

/** 这几张卡各自的全部事件（seq 升序），逐卡走 (project, target, seq) 索引 */
export function eventsOf(db: Database, project: string, ids: readonly string[]): Map<string, LedgerEvent[]> {
  return new Map(ids.map((id) => [id, listEvents(db, { project, target: id })]));
}

/** 这几张卡的步骤行（与 stepsByTask 同序：step, round） */
export function stepsOf(db: Database, ids: readonly string[]): Map<string, TaskStep[]> {
  return new Map(ids.map((id) => [id, listSteps(db, id)]));
}

/**
 * 产品板（ledger-product-board*.ts）的事件：full 里的卡（还在跑的、以及卡读不到的节点）给全部事件，照旧算久未动、成员、进当前阶段的时刻；
 * 其余卡只读时间线上第一次进 build / verified / done / cancelled 的那几条（吞吐、ETA、完成时刻只 find 这几个阶段的第一段），
 * 它们在前沿里是 completed / deferred 行，久未动、成员不进输出。
 */
const FIRST_MARKS = `SELECT * FROM events WHERE seq IN (SELECT MIN(seq) FROM (SELECT target, seq, ${ST} AS st FROM events NOT INDEXED WHERE project = ?1 AND ${IS_MARK})
  WHERE st IN ('build', 'verified', 'done', 'cancelled') GROUP BY target, st) ORDER BY seq`;

export function productEvents(db: Database, project: string, full: readonly string[]): Map<string, LedgerEvent[]> {
  const out = new Map<string, LedgerEvent[]>();
  for (const r of db.query(FIRST_MARKS).all(project) as Record<string, unknown>[]) {
    const e = toEvent(r);
    const list = out.get(e.target);
    if (list) list.push(e);
    else out.set(e.target, [e]);
  }
  for (const [id, events] of eventsOf(db, project, full)) if (events.length) out.set(id, events);
  return out;
}
