/**
 * RLOCK3：车道读侧认「正式停滞让锁」。RLOCK2 让锁只删这张卡的 scheduler_resources 行；车道对没拿锁的卡按 extra.fileGlobs 算占用，
 * 让出去的文件在 DAG 车道（图内节点、图外忙卡）里照样挡。这里判哪些卡此刻不再按声明范围占用，图内图外同一份。
 * 只读：调用方在一个 deferred 读事务里连同锁表一起取（一次快照）；真正的锁门仍是派单时 planIntent 的重叠 CAS。
 * 全部满足才算让了：
 *  - 卡此刻在本项目一行锁都没有（有锁按锁的实际范围占用，车道那边先处理）；
 *  - 本项目这张卡最新一条让锁记录是调度服务按正规写法记的：actor scheduler、去重键 = 卡 + 停滞起点、
 *    资源清单与当时删掉的锁行一致、至少让出一把文件锁；
 *  - 这条之后没有交付 / 审查 / 阶段 / 步骤事件、没有新的调度计划（派单 / 重新拿锁）；
 *  - 没有未结意图、活出借单、合并在途；extra 读得了、没冻结、有流程记录且不是 security。
 * 普通 note、空锁表、manual / blocked、时长都不是让锁证明；缺表、读坏一律空集（保持原占用）。
 */
import type { Database } from "bun:sqlite";
import { isFileResource } from "./ledger-scheduler-lease-sync.js";
import { RELEASED_OP, yieldDedupKey } from "./scheduler-lock-yield.js";
import { readYieldCards, resumedAfter } from "./scheduler-lock-yield-read.js";

const TABLES = ["scheduler_resources", "scheduler_intents", "task_workflows", "scheduler_merges", "lend_orders"];

interface Note { seq: number; target: string; actor: string; dedupKey: string | null; data: string }

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** null = data 读不了（当作坏掉的让锁记录，不跳过） */
function parse(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

/** 正规让锁记录：调度服务写、去重键对得上停滞起点、资源清单 = 删掉的锁行、含文件锁 */
function formal(n: Note): boolean {
  const d = parse(n.data);
  if (!d || d.op !== RELEASED_OP || n.actor !== "scheduler" || (d.basis !== "blocked" && d.basis !== "idle")) return false;
  if (!Number.isSafeInteger(d.since) || n.dedupKey !== yieldDedupKey(n.target, d.since as number)) return false;
  if (!strings(d.resources) || !d.resources.some(isFileResource) || !Array.isArray(d.rows)) return false;
  const rows = d.rows.map((r: unknown) => (r && typeof r === "object" ? (r as { resource?: unknown }).resource : null));
  return strings(rows) && JSON.stringify([...rows].sort()) === JSON.stringify([...d.resources].sort());
}

const plannedAfter = (db: Database, taskId: string, seq: number): boolean =>
  !!db.query("SELECT 1 FROM events WHERE target = ? AND seq > ? AND kind = 'scheduler' AND json_extract(data, '$.op') = 'plan' LIMIT 1").get(taskId, seq);

/** ids 里正式让过锁、之后没恢复的卡：车道不再按它们声明的 fileGlobs 算占用 */
export function laneYielded(db: Database, project: string, ids: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (!ids.length) return out;
  try {
    for (const t of TABLES) if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) return out;
    const marks = ids.map(() => "?").join(",");
    const notes = db.query(`SELECT seq, target, actor, dedupKey, data FROM events WHERE project = ? AND kind = 'note' AND target IN (${marks})
      AND instr(data, ?) > 0 ORDER BY seq`).all(project, ...ids, RELEASED_OP) as Note[];
    const latest = new Map<string, Note>();
    for (const n of notes) {
      const d = parse(n.data); // 读不了的也算一条（坏的）让锁记录：最新一条坏了不回退去认更早的
      if (!d || d.op === RELEASED_OP) latest.set(n.target, n);
    }
    const proven = [...latest.values()].filter(formal);
    if (!proven.length) return out;
    const pm = proven.map(() => "?").join(",");
    const locked = new Set((db.query(`SELECT DISTINCT taskId FROM scheduler_resources WHERE project = ? AND taskId IN (${pm})`)
      .all(project, ...proven.map((n) => n.target)) as { taskId: string }[]).map((r) => r.taskId));
    const cards = new Map(readYieldCards(db, project, proven.map((n) => n.target)).map((c) => [c.id, c]));
    for (const n of proven) {
      const c = cards.get(n.target);
      if (!c || locked.has(c.id) || !c.extra || c.extra.frozen === true || !c.workflow || c.workflow.template === "security") continue;
      if (c.liveIntents.length || c.liveOrders.length || c.mergeOpen) continue;
      if (resumedAfter(db, c.id, n.seq) || plannedAfter(db, c.id, n.seq)) continue;
      out.add(c.id);
    }
  } catch { return new Set(); }
  return out;
}
