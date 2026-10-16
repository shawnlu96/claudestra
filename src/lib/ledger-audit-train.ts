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
 * AUDTRAIN3：「排队中」只认真实的项目合并槽（ledger-audit-train-facts.ts）——当前 head 已合并（含等部署）的卡一律原规则；
 * 槽在别卡手里、自己当前 head 没合并、自己没有记录或记录在 ready / await_ci，才算在等槽；没人持槽不算排队（on 仍按列车空出起算）。
 * 持槽卡已合并在等部署时，说明写它在等部署而不是在合。槽事实缺失 / 读不了 = 按 off。tests/ledger-audit-train-recovery*.test.ts。
 * AUDTRAIN5：foreign_repo 的卡（foreignRepoOf：卡的 PR / extra.repo 与项目仓库不同）不参加项目列车，私仓接管也一样（私仓串行是私仓机制）——
 * 一律 PLAIN。项目仓库在取数层每项目读一次（projectRepoFor），未知 / 读不了 = 不判 foreign，照原规则。tests/ledger-audit-train-foreign-repo.test.ts。
 */
import type { Database } from "bun:sqlite";
import { readTrainFacts, type TrainFacts } from "./ledger-audit-train-facts.js";
import type { LedgerTask } from "./ledger-stages.js";
import type { RecoveryMode, RecoveryPolicyPort } from "./recovery-policy.js";
import { foreignRepoOf, projectRepoFor } from "./scheduler-foreign-repo.js";

const HOLDING_PHASES: readonly string[] = ["ready", "updating", "await_review", "await_ci", "merging"];

interface TrainRun { taskId: string; phase: string; createdAt: number }
/** active = 占着列车的记录（createdAt 升序）；freedAt = 列车最近一次空出的时刻，没有过 = null */
export interface MergeTrainFact { active: readonly TrainRun[]; freedAt: number | null }
/** undefined = 没有 scheduler_merges 表 / 快照没带：ship_stalled 按原规则；trainFacts 缺 = 按 off（AUDTRAIN3）；projectRepo 缺 / null = 项目仓库未知（AUDTRAIN5） */
export interface MergeTrainInputs { mergeTrain?: MergeTrainFact; trainFacts?: TrainFacts; projectRepo?: string | null }
/** trainSlots 认的卡：pr / extra 给 foreignRepoOf 判仓库（真实调用传完整任务） */
type TrainCard = { id: string; stage: string } & Partial<Pick<LedgerTask, "pr" | "extra">>;

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

/** 项目仓库（AUDTRAIN5）：读不了 = 未知，不影响列车与槽事实 */
function projectRepoSafe(project: string): string | null {
  try {
    return projectRepoFor(project);
  } catch {
    return null;
  }
}

/** 快照取数（ledger-audit-snapshot.ts）：列车记录与合并槽事实在同一个只读事务里读；项目仓库在事务外每项目读一次 */
export function readAuditTrain(db: Database, project: string, tasks: readonly { task: { id: string; stage: string } }[]): MergeTrainInputs {
  let train: MergeTrainInputs;
  try {
    train = db.transaction(() => ({ mergeTrain: readMergeTrain(db, project, tasks), trainFacts: readTrainFacts(db, project) }))();
  } catch {
    return {}; // 读不了：两样都缺，按原规则
  }
  return train.mergeTrain && train.trainFacts ? { ...train, projectRepo: projectRepoSafe(project) } : train; // 缺事实时 trainSlots 本就按 off
}

/** 自己在等槽时可以有的最新记录：没有、旧 head 已合 / 已结，或已登记但还没发合并（ready / await_ci，含让过槽的） */
const WAITING_PHASES: readonly (string | null)[] = [null, "merged", "resolved", "ready", "await_ci"];

/** 给 shipStalled 用：一张卡 → 它在列车上的处境。没带列车 / 槽事实、off、foreign_repo、不在 merge 阶段、当前 head 已合并、自己持槽 = PLAIN（原规则） */
export function trainSlots(s: { project: string } & MergeTrainInputs, policy: RecoveryPolicyPort): (task: TrainCard) => TrainSlot {
  const train = s.mergeTrain, facts = s.trainFacts;
  const mode = train && facts ? trainMode(policy, s.project) : "off";
  if (!train || !facts || mode === "off") return () => PLAIN;
  const holder = facts.holder, repo = s.projectRepo ?? null;
  return (task) => {
    if (foreignRepoOf({ pr: task.pr ?? null, extra: task.extra ?? {} }, repo)) return PLAIN; // AUDTRAIN5：不参加项目列车（含私仓接管）
    const self = facts.cards[task.id];
    if (task.stage !== "merge" || !self || self.stage !== "merge" || self.merged) return PLAIN; // 已合并等部署：不是排队
    if (!WAITING_PHASES.includes(self.phase) || holder?.taskId === task.id) return PLAIN;
    // 没人持槽不算排队；自己也没有进行中记录时，on 照 AUDTRAIN1 从列车最近一次空出起算
    const queued = self.phase === "ready" || self.phase === "await_ci";
    if (!holder) return mode === "on" && !queued ? { ...PLAIN, freedAt: train.freedAt } : PLAIN;
    if (mode === "on") return { ...PLAIN, parked: true };
    const why = holder.merged ? `合并槽在 ${holder.taskId}，它已合并、在等部署` : `列车在合 ${holder.taskId}，${holder.phase ?? "未开始合并"}`;
    return { ...PLAIN, note: `（排队中：${why}）` };
  };
}
