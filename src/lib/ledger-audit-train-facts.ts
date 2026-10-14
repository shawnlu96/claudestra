/**
 * AUDTRAIN3：巡检判「排队中」用的一致只读事实（ledger-audit-train.ts trainSlots 用）。AUDTRAIN1 只看 scheduler_merges 的进行中记录，
 * 已合并等部署的卡（最新记录 merged、仍在 merge 阶段）被当成「没有自己记录」的排队卡；自身 ready / await_ci 却在等别卡持槽的卡反而不标。
 * 这里改认真实的项目合并槽 `merge:<project>`（scheduler_resources）：
 * - holder = 槽的持有者：卡、意图、意图对应合并记录的 phase（没有记录 = null）、是否已合并（意图记录 merged，或卡当前 head 已合并）；
 *   意图的合并记录记在别的项目 = 前后不一致，不当本项目的持槽者；
 * - cards = 本项目每张卡：现读的阶段、当前 head 是否已合并（同 scheduler-merge-train-tick.ts 的口径：reviewedHead 对上当前 head 且 phase = merged；
 *   旧 head 的 merged、resolved 都不算）、最新一条合并记录的 phase。
 * 任务、合并记录、资源在同一个只读事务里读（只有 SELECT，不建表、不迁移、不写）；缺表或读失败 = undefined（巡检按 off）。
 * AUDTRAIN4：当前 head 已合并还认 PM 的人工合入登记（ledger-manual-merge-record.ts validManualMerge：同项目、当前 head / PR / specRev / round、
 * 本次进入 merge 之后的完整 v1 事实），与 scheduler_merges 取或，同在上面那个读事务里；events 表缺失同样 = undefined。
 * tests/ledger-audit-train-recovery*.test.ts。
 */
import type { Database } from "bun:sqlite";
import { MANUAL_MERGE_RECORD_OP, mergeEntrySeq, validManualMerge } from "./ledger-manual-merge-record.js";

interface TrainCardFact { stage: string; merged: boolean; phase: string | null }
interface TrainHolderFact { taskId: string; intentId: string; phase: string | null; merged: boolean }
export interface TrainFacts { holder: TrainHolderFact | null; cards: Readonly<Record<string, TrainCardFact>> }

const hasTable = (db: Database, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** 本项目 merge 阶段的卡里，当前这次 merge 有有效人工合入登记的 */
function manualMerged(db: Database, project: string, tasks: readonly TaskRow[]): Set<string> {
  const rows = db.query("SELECT seq, target, data FROM events WHERE project = ? AND kind = 'scheduler' AND json_extract(data, '$.op') = ?")
    .all(project, MANUAL_MERGE_RECORD_OP) as { seq: number; target: string; data: string }[];
  const out = new Set<string>();
  for (const t of tasks) {
    const mine = rows.filter((r) => r.target === t.id);
    if (t.stage !== "merge" || !mine.length) continue;
    const id = { headSHA: t.headSHA, pr: t.pr, specRev: t.specRev, round: t.round, entrySeq: mergeEntrySeq(db, t.id) };
    if (mine.some((r) => validManualMerge(JSON.parse(r.data) as Record<string, unknown>, r.seq, id))) out.add(t.id);
  }
  return out;
}

interface TaskRow { id: string; stage: string; merged: number; phase: string | null; headSHA: string | null; pr: string | null; specRev: number; round: number }

function read(db: Database, project: string): TrainFacts | undefined {
  if (!["tasks", "events", "scheduler_merges", "scheduler_resources"].every((t) => hasTable(db, t))) return undefined;
  const tasks = db.query(`SELECT t.id, t.stage, t.headSHA, t.pr, t.specRev, t.round, EXISTS (SELECT 1 FROM scheduler_merges m WHERE m.taskId = t.id AND t.headSHA IS NOT NULL
    AND lower(m.reviewedHead) = lower(t.headSHA) AND m.phase = 'merged') AS merged,
    (SELECT m.phase FROM scheduler_merges m WHERE m.taskId = t.id ORDER BY m.createdAt DESC, m.rowid DESC LIMIT 1) AS phase
    FROM tasks t WHERE t.project = ?`).all(project) as TaskRow[];
  const manual = manualMerged(db, project, tasks);
  const cards: Record<string, TrainCardFact> = {};
  for (const t of tasks) cards[t.id] = { stage: t.stage, merged: !!t.merged || manual.has(t.id), phase: t.phase };
  const slot = db.query(`SELECT r.taskId, r.intentId, m.phase FROM scheduler_resources r LEFT JOIN scheduler_merges m ON m.intentId = r.intentId
    WHERE r.project = ? AND r.resource = ? AND (m.project IS NULL OR m.project = r.project)`).get(project, `merge:${project}`) as { taskId: string; intentId: string; phase: string | null } | null;
  const holder = slot && { ...slot, merged: slot.phase === "merged" || cards[slot.taskId]?.merged === true };
  return { holder, cards };
}

/** 只读取数：同一个读事务（已在事务里就是保存点），失败 = undefined */
export function readTrainFacts(db: Database, project: string): TrainFacts | undefined {
  try {
    return db.transaction(() => read(db, project))();
  } catch {
    return undefined;
  }
}
