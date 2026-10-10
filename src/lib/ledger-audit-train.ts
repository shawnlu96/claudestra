/**
 * AUDTRAIN1：合并列车同一项目一次只合一张卡，后面排队的 merge 卡还没有自己的 scheduler_merges 记录——停着是在排队，不是「合并部署停滞」。
 * 这里只给 ship_stalled（ledger-audit.ts shipStalled）提供两样只读事实和一个判定，落库 / 去重 / 发送、合并列车、调度器都不动：
 * - 占着列车的记录：phase 在 ready / updating / await_review / await_ci / merging，并且卡现在就在 merge 阶段、这是它最新的一条记录。
 *   update-branch 改 head 后没收尾的旧意图（卡早已上线或换了新意图）留着 await_review，不算占着列车。
 * - 列车最近一次空出的时刻：phase 为 merged / resolved 的记录里最大的 updatedAt。
 * 判定只管 merge 阶段、自己没有占着列车记录的卡；正在被合的那张、live 阶段的卡一律按原规则。
 * 开关 = 恢复策略 auditTrainQueue（缺省 observe）：off 与原来逐字一致；observe 照报，排队中的卡在 detail 末尾注明列车在合谁；
 * on 排队中的卡不报（与冻结一样 keep 住原 key），列车空着时停滞从它最近一次空出起算。没有这张表 / 策略读不了 = 按 off。
 * tests/ledger-audit-train.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { RecoveryMode, RecoveryPolicyPort } from "./recovery-policy.js";

const HOLDING_PHASES: readonly string[] = ["ready", "updating", "await_review", "await_ci", "merging"];

interface TrainRun { taskId: string; phase: string; createdAt: number }
/** active = 占着列车的记录（createdAt 升序）；freedAt = 列车最近一次空出的时刻，没有过 = null */
export interface MergeTrainFact { active: readonly TrainRun[]; freedAt: number | null }
/** undefined = 没有 scheduler_merges 表 / 快照没带：ship_stalled 按原规则 */
export interface MergeTrainInputs { mergeTrain?: MergeTrainFact }

/** 一张卡在列车上的处境：parked = 排队中且不报（on）；freedAt = 停滞改从这一刻起算（on、列车空着）；note = 加在 detail 末尾的说明（observe） */
export interface TrainSlot { parked: boolean; freedAt: number | null; note: string }
const PLAIN: TrainSlot = { parked: false, freedAt: null, note: "" };

/** 只读取数；tasks = 本项目的任务（只用来认谁现在在 merge 阶段） */
export function readMergeTrain(db: Database, project: string, tasks: readonly { task: { id: string; stage: string } }[]): MergeTrainFact | undefined {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_merges'").get()) return undefined;
  const rows = db.query("SELECT taskId, phase, createdAt FROM scheduler_merges WHERE project = ? ORDER BY createdAt, rowid").all(project) as TrainRun[];
  const latest = new Map(rows.map((r) => [r.taskId, r])); // 同一张卡后写的盖掉先写的 = 它最新的一条
  const merging = new Set(tasks.filter((t) => t.task.stage === "merge").map((t) => t.task.id));
  const active = rows.filter((r) => latest.get(r.taskId) === r && merging.has(r.taskId) && HOLDING_PHASES.includes(r.phase));
  const freed = db.query("SELECT MAX(updatedAt) AS at FROM scheduler_merges WHERE project = ? AND phase IN ('merged', 'resolved')").get(project) as { at: number | null } | null;
  return { active, freedAt: freed?.at ?? null };
}

function trainMode(policy: RecoveryPolicyPort, project: string): RecoveryMode {
  try {
    return policy(project, "auditTrainQueue").mode;
  } catch {
    return "off"; // 策略读不了：保守按原规则
  }
}

/** 给 shipStalled 用：一张卡 → 它在列车上的处境。没带列车事实、off、不在 merge 阶段、自己就占着列车 = PLAIN（原规则） */
export function trainSlots(s: { project: string } & MergeTrainInputs, policy: RecoveryPolicyPort): (task: { id: string; stage: string }) => TrainSlot {
  const train = s.mergeTrain;
  const mode = train ? trainMode(policy, s.project) : "off";
  if (!train || mode === "off") return () => PLAIN;
  const holder = train.active[0];
  return (task) => {
    if (task.stage !== "merge" || train.active.some((r) => r.taskId === task.id)) return PLAIN;
    if (!holder) return mode === "on" ? { ...PLAIN, freedAt: train.freedAt } : PLAIN;
    return mode === "on" ? { ...PLAIN, parked: true } : { ...PLAIN, note: `（排队中：列车在合 ${holder.taskId}，${holder.phase}）` };
  };
}
