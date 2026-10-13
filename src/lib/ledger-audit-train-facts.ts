/**
 * AUDTRAIN3：巡检判「排队中」用的一致只读事实（ledger-audit-train.ts trainSlots 用）。AUDTRAIN1 只看 scheduler_merges 的进行中记录，
 * 已合并等部署的卡（最新记录 merged、仍在 merge 阶段）被当成「没有自己记录」的排队卡；自身 ready / await_ci 却在等别卡持槽的卡反而不标。
 * 这里改认真实的项目合并槽 `merge:<project>`（scheduler_resources）：
 * - holder = 槽的持有者：卡、意图、意图对应合并记录的 phase（没有记录 = null）、是否已合并（意图记录 merged，或卡当前 head 已合并）；
 *   意图的合并记录记在别的项目 = 前后不一致，不当本项目的持槽者；
 * - cards = 本项目每张卡：现读的阶段、当前 head 是否已合并（同 scheduler-merge-train-tick.ts 的口径：reviewedHead 对上当前 head 且 phase = merged；
 *   旧 head 的 merged、resolved 都不算）、最新一条合并记录的 phase。
 * 任务、合并记录、资源在同一个只读事务里读（只有 SELECT，不建表、不迁移、不写）；缺表或读失败 = undefined（巡检按 off）。
 * tests/ledger-audit-train-recovery*.test.ts。
 */
import type { Database } from "bun:sqlite";

interface TrainCardFact { stage: string; merged: boolean; phase: string | null }
interface TrainHolderFact { taskId: string; intentId: string; phase: string | null; merged: boolean }
export interface TrainFacts { holder: TrainHolderFact | null; cards: Readonly<Record<string, TrainCardFact>> }

const hasTable = (db: Database, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

function read(db: Database, project: string): TrainFacts | undefined {
  if (!["tasks", "scheduler_merges", "scheduler_resources"].every((t) => hasTable(db, t))) return undefined;
  const tasks = db.query(`SELECT t.id, t.stage, EXISTS (SELECT 1 FROM scheduler_merges m WHERE m.taskId = t.id AND t.headSHA IS NOT NULL
    AND lower(m.reviewedHead) = lower(t.headSHA) AND m.phase = 'merged') AS merged,
    (SELECT m.phase FROM scheduler_merges m WHERE m.taskId = t.id ORDER BY m.createdAt DESC, m.rowid DESC LIMIT 1) AS phase
    FROM tasks t WHERE t.project = ?`).all(project) as { id: string; stage: string; merged: number; phase: string | null }[];
  const cards: Record<string, TrainCardFact> = {};
  for (const t of tasks) cards[t.id] = { stage: t.stage, merged: !!t.merged, phase: t.phase };
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
