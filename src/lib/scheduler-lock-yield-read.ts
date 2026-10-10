/**
 * RLOCK2 的取数（规则在 scheduler-lock-yield.ts）：一个 deferred 读事务（query_only 连接也能跑），读法同 ledger-deadlock-read.ts：
 * 只 SELECT、不迁移；老库缺表 = 没有这类事实；表在但读坏了进 unknown（不确定就不让）。命令在写事务里调同一个函数重核。
 */
import type { Database } from "bun:sqlite";
import type { YieldCard, YieldFacts, YieldHeld } from "./scheduler-lock-yield.js";
import { contendKey, RELEASED_OP } from "./scheduler-lock-yield.js";

const hasTable = (db: Database, table: string): boolean =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

const PROGRESS_KINDS = "('deliver','review','stage','step')";
const LIVE_INTENT = "('pending','submitted','unknown')";
const LIVE_ORDER = "('pooled','claimed','unknown')";

type Row = { id: string; project: string; stage: string; branch: string | null; extra: string | null };

function parseExtra(raw: string | null): YieldCard["extra"] {
  try {
    const v = JSON.parse(raw ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? v as YieldCard["extra"] : null;
  } catch { return null; } // 读不了的 extra 判不了冻结：返回 null，判定按豁免不让
}

const byTask = <T extends { taskId: string }>(rows: T[]): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(r.taskId, [...(m.get(r.taskId) ?? []), r]);
  return m;
};

type MergeRow = { taskId: string; intentId: string; phase: string; updatedAt: number };
const MERGE_OPEN: readonly string[] = ["ready", "updating", "await_ci", "merging", "unknown"];

/** 每张卡只取 updatedAt 最新的一条合并记录（同一时刻按 intentId 排序取最后一条），较早的不论 phase 都不看 */
function latestMerges(db: Database, project: string, ids: readonly string[], marks: string): Map<string, MergeRow> {
  const rows = db.query(`SELECT taskId, intentId, phase, updatedAt FROM scheduler_merges WHERE project = ? AND taskId IN (${marks})
    ORDER BY taskId, updatedAt, intentId`).all(project, ...ids) as MergeRow[];
  return new Map(rows.map((r) => [r.taskId, r]));
}

/** mergeOpen：最新一条在途或有活的 merge 意图；mergeAwaitReview：最新一条是 await_review 且没有活的 merge 意图 */
function mergeFacts(m: MergeRow | undefined, liveMerge: boolean): Pick<YieldCard, "mergeOpen" | "mergeAwaitReview"> {
  const awaiting = !liveMerge && m?.phase === "await_review";
  return { mergeOpen: liveMerge || (!!m && MERGE_OPEN.includes(m.phase)),
    mergeAwaitReview: awaiting ? { intentId: m!.intentId, updatedAt: m!.updatedAt } : null };
}

/** 这几张卡的让锁判定事实（意图 / 出借单 / 进展 / 合并 / 流程）；车道的让锁读侧（dag-lane-lock-yield.ts）也用这一份 */
export function readYieldCards(db: Database, project: string, ids: readonly string[]): YieldCard[] {
  if (!ids.length) return [];
  const marks = ids.map(() => "?").join(",");
  const rows = db.query(`SELECT id, project, stage, branch, extra FROM tasks WHERE project = ? AND id IN (${marks}) ORDER BY id`).all(project, ...ids) as Row[];
  const one = (sql: string) => new Map((db.query(sql).all(project, ...ids) as { taskId: string; at: number }[]).map((r) => [r.taskId, r.at]));
  const blocked = one(`SELECT target AS taskId, MAX(ts) AS at FROM events WHERE project = ? AND target IN (${marks}) AND kind = 'stage'
    AND json_extract(data, '$.to') = 'blocked' GROUP BY target`);
  const progress = one(`SELECT target AS taskId, MAX(ts) AS at FROM events WHERE project = ? AND target IN (${marks}) AND kind IN ${PROGRESS_KINDS} GROUP BY target`);
  const wf = hasTable(db, "task_workflows") ? new Map((db.query(`SELECT taskId, template, mode FROM task_workflows WHERE project = ? AND taskId IN (${marks})`)
    .all(project, ...ids) as { taskId: string; template: string; mode: string }[]).map((r) => [r.taskId, { template: r.template, mode: r.mode }])) : new Map();
  const intents = byTask(db.query(`SELECT taskId, id, action, status, updatedAt FROM scheduler_intents WHERE project = ? AND taskId IN (${marks})`)
    .all(project, ...ids) as { taskId: string; id: string; action: string; status: string; updatedAt: number }[]);
  const orders = hasTable(db, "lend_orders") ? byTask(db.query(`SELECT taskId, orderId, status, updatedAt FROM lend_orders WHERE taskId IN (${marks})`)
    .all(...ids) as { taskId: string; orderId: string; status: string; updatedAt: number }[]) : new Map();
  const merges = hasTable(db, "scheduler_merges") ? latestMerges(db, project, ids, marks) : new Map<string, MergeRow>();
  return rows.map((r) => {
    const is = intents.get(r.id) ?? [], os = (orders.get(r.id) ?? []) as { orderId: string; status: string; updatedAt: number }[];
    const live = is.filter((i) => LIVE_INTENT.includes(`'${i.status}'`));
    return {
      id: r.id, project: r.project, stage: r.stage, branch: r.branch, extra: parseExtra(r.extra), workflow: wf.get(r.id) ?? null,
      blockedAt: blocked.get(r.id) ?? null, progressAt: progress.get(r.id) ?? null,
      liveIntents: live.map((i) => i.id).sort(), intentAt: is.length ? Math.max(...is.map((i) => i.updatedAt)) : null,
      liveOrders: os.filter((o) => LIVE_ORDER.includes(`'${o.status}'`)).map((o) => o.orderId).sort(),
      orderAt: os.length ? Math.max(...os.map((o) => o.updatedAt)) : null,
      ...mergeFacts(merges.get(r.id), live.some((i) => i.action === "merge")),
    };
  });
}

function held(db: Database, project: string): YieldHeld[] {
  return db.query("SELECT resource, taskId, intentId, acquiredAt, scope FROM scheduler_resources WHERE project = ? ORDER BY resource, taskId")
    .all(project) as YieldHeld[];
}

/** 持锁卡 + 还要拿文件锁的 auto 卡（算「谁因此能开工」）+ 让过锁的卡（恢复时重新拿锁的观察） */
function facts(db: Database, project: string, extra: readonly string[]): YieldFacts {
  if (!hasTable(db, "scheduler_resources") || !hasTable(db, "scheduler_intents")) return { project, cards: [], held: [], unknown: [] };
  try {
    const rows = held(db, project);
    const waiting = hasTable(db, "task_workflows") ? (db.query(`SELECT w.taskId FROM task_workflows w JOIN tasks t ON t.id = w.taskId
      WHERE w.project = ? AND w.mode = 'auto' AND t.stage IN ('spec','restate','build','fix')`).all(project) as { taskId: string }[]).map((r) => r.taskId) : [];
    const ids = [...new Set([...rows.map((h) => h.taskId), ...waiting, ...extra])].sort();
    return { project, cards: readYieldCards(db, project, ids), held: rows, unknown: [] };
  } catch (e) {
    return { project, cards: [], held: [], unknown: [`让锁取数读不了：${(e as Error).message.slice(0, 160)}`] };
  }
}

export interface Released { seq: number; taskId: string; contended: boolean }

/** 让过锁、还没交过「拿不回」通知的记录；reacquired = 让锁之后又派过带文件锁的意图（正常拿回，观察结束） */
export function releasedPending(db: Database, project: string): Released[] {
  const rows = db.query(`SELECT e.seq, e.target AS taskId FROM events e WHERE e.project = ? AND e.kind = 'note' AND json_extract(e.data, '$.op') = ?
    AND NOT EXISTS (SELECT 1 FROM events s WHERE s.dedupKey = 'lock-yield-contend:' || e.seq || ':sent')
    AND NOT EXISTS (SELECT 1 FROM events p WHERE p.target = e.target AND p.seq > e.seq AND p.kind = 'scheduler' AND json_extract(p.data, '$.op') = 'plan'
      AND EXISTS (SELECT 1 FROM json_each(p.data, '$.resources') r WHERE instr(r.value, ':') = 0 AND substr(r.value, 1, 1) != '/'))
    ORDER BY e.seq`).all(project, RELEASED_OP) as { seq: number; taskId: string }[];
  return rows.map((r) => ({ ...r, contended: !!db.query("SELECT 1 FROM events WHERE dedupKey = ?").get(contendKey(r.seq)) }));
}

/** 让锁之后卡有没有恢复推进：交付 / 审查 / 阶段 / 步骤事件 */
export function resumedAfter(db: Database, taskId: string, seq: number): boolean {
  return !!db.query(`SELECT 1 FROM events WHERE target = ? AND seq > ? AND kind IN ${PROGRESS_KINDS} LIMIT 1`).get(taskId, seq);
}

export function readYieldFacts(db: Database, project: string, extra: readonly string[] = []): YieldFacts {
  return db.transaction(() => facts(db, project, extra)).deferred();
}
