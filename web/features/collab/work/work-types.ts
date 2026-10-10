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
 * 团队数据源的同一块展示（team-work-model.ts 转出来）：中心镜像没有开工时间、轮次、估时，这几项不带，视图也不显示；
 * machine = 执行实例对应的成员名，对不上是实例代号原样，没有执行实例为 null；team = 卡的镜像事实（新鲜度、阻塞提问），未绑卡的节点没有
 */
export interface TeamWorkRow {
  taskId: string | null; featureId: string | null; nodeKey: string | null; title: string;
  who: string | null; machine: string | null; stage: Stage | null; reason: string | null; team: TeamTaskFacts | null;
}
export interface TeamWorkBoard {
  now: number; working: TeamWorkRow[]; waiting: TeamWorkRow[]; todo: { ready: TeamWorkRow[]; blocked: TeamWorkRow[] };
  machines: Record<string, number>;
  /** 各 feature 的镜像证据（总览 ov.mirror），显示时随时间重判 */
  mirror: readonly MirrorFact[];
}
