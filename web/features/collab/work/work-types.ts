/** Compact /work wire contract; the browser never imports backend modules. */
import type { MirrorFact, Stage, TeamTaskFacts } from '../collab-model';
export interface WorkRow {
  taskId: string | null; featureId: string | null; nodeKey: string | null; title: string;
  who: string | null; machine: string; step: 'restate' | 'write' | 'review' | 'fix' | 'merge' | 'deploy' | 'publishing' | null;
  round: number; since: number; normalMinutes: number; remainingMinutes: number; overMinutes: number;
  reason: string | null; code: string | null; estimate: string;
}
export interface WorkBoard {
  now: number; asOfSeq: number; working: WorkRow[]; waiting: WorkRow[]; todo: { ready: WorkRow[]; blocked: WorkRow[] };
  legacyTotal?: number;
  legacy?: { taskId: string; title: string; stage: string }[];
  machines: Record<string, number>; completionHours: number | null; availableSlots: number;
}
/**
 * 团队数据源的同一块展示（team-work-model.ts 转出、team-work-merge.ts 合并命名）：中心镜像没有开工时间、轮次、估时，团队行不带，视图也不显示；
 * instance = 执行实例 id 原样（只进 title 提示），machine = 给人看的机器名（team-instance-names.ts），没有执行实例为 null；
 * team = 卡的镜像事实（新鲜度、阻塞提问），未绑卡的节点没有
 */
export interface TeamWorkRow {
  taskId: string | null; featureId: string | null; nodeKey: string | null; title: string;
  who: string | null; instance: string | null; machine: string | null; stage: Stage | null; reason: string | null; team: TeamTaskFacts | null;
}
/** 主场是本机、本机 /work 看板里有同卡号的行：整行换成本机看板的行（执行者、步骤、轮次、已持续、等待原因） */
export type TeamBoardRow = TeamWorkRow | WorkRow;
/** 四栏：在干活（写 / 审 / 修）/ 在等合并 / 在等 / 待做 */
export interface WorkColumns<R> { working: R[]; merging: R[]; waiting: R[] }
export interface TeamWorkBoard extends WorkColumns<TeamBoardRow> {
  now: number; todo: { ready: TeamWorkRow[]; blocked: TeamWorkRow[] };
  /** 在干活的行按机器名计数（键已是给人看的名字） */
  machines: Record<string, number>;
  /** 各 feature 的镜像证据（总览 ov.mirror），显示时随时间重判 */
  mirror: readonly MirrorFact[];
}
