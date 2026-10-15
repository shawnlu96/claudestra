/**
 * 按卡号查「谁在干活」那一份快照（followup-reliability-UXCARD3）：任务详情「现在」只按这些事实拼句子，不另写一套调度判定。
 * 快照 = use-dag-panes.tsx useBoard 已读的那一份（本机 /work；团队 = team-work-merge.ts 合并命名后的团队板），不另起读口。
 * - 栏位：在干活 / 在等合并 / 在等（四栏同 team-work-merge.ts localColumns），老卡（没有调度流程记录，ledger-work-board.ts legacy）；
 * - 出借（三条任一）：who 以 `peer:` 开头（/work 写 `peer:<peer> · <家族>`）；本机行的机器不是本机；执行者名带 `@<机器>` 后缀。
 *   /work 对出借会话的机器恒写本机（ledger-work-board.ts baseRow），靠第三条在网页侧兜住；
 * - 主场本机卡（团队行的执行实例 = 本机实例）只认换上来的本机行：还是团队行（本机 /work 没合进来）按「快照没有这张卡」返回 null。
 * 纯函数；单测 tests/web-collab-task-work-facts.test.ts。
 */
import type { Stage } from '../collab-model';
import { LOCAL_MACHINE } from '../team-instance-names';
import { sharedIdentity } from '../team-source-key';
import { COLUMNS, localColumns } from './team-work-merge';
import type { TeamBoardRow, TeamWorkBoard, WorkBoard, WorkRow } from './work-types';

export type WorkColumn = 'working' | 'merging' | 'waiting' | 'legacy';
export interface TaskWorkFacts {
  column: WorkColumn;
  /** 执行者（审查步骤是审查员）；出借时是 peer 原样的 who，界面用 machine / family */
  who: string | null;
  lent: boolean;
  /** 出借：执行者所在的伙伴机器、家族（codex / claude…）；不知道为 null */
  machine: string | null;
  family: string | null;
  step: WorkRow['step'];
  /** 轮次：团队行、老卡不知道为 null */
  round: number | null;
  /** 开始时刻（毫秒）：团队行、老卡不知道为 null */
  since: number | null;
  reason: string | null;
  code: string | null;
  /** 老卡停在哪个阶段；其余为 null */
  stage: string | null;
  /** 团队行（别的机器为主场，中心投影）：没有开工时间 / 轮次，卡的镜像提示（collab-model.ts teamNote）照旧另起一行 */
  team: boolean;
}

const isLocalRow = (r: TeamBoardRow): r is WorkRow => 'since' in r;
const LOCAL: ReadonlySet<string> = new Set(['local', LOCAL_MACHINE]);
const TEAM_STEP: Partial<Record<Stage, WorkRow['step']>> = { build: 'write', review: 'review', fix: 'fix', merge: 'merge', restate: 'restate' };

/** 出借判定与机器 / 家族：`peer:<peer> · <家族>`、本机行机器不是本机、`<名>@<机器>` 三条任一 */
export function lendOf(who: string | null, machine: string | null, localRow: boolean): { lent: boolean; machine: string | null; family: string | null } {
  const peer = who?.match(/^peer:([^·\s]+)\s*(?:·\s*(.+))?$/);
  if (peer) return { lent: true, machine: peer[1]!.trim(), family: peer[2]?.trim() || null };
  const at = who?.match(/^[^@\s]+@([^@\s]+)$/);
  if (at) return { lent: true, machine: at[1]!, family: null };
  if (localRow && machine && !LOCAL.has(machine)) return { lent: true, machine, family: null };
  return { lent: false, machine: null, family: null };
}

function rowFacts(r: TeamBoardRow, column: WorkColumn): TaskWorkFacts {
  const local = isLocalRow(r);
  return { column, who: r.who, ...lendOf(r.who, r.machine, local), step: local ? r.step : (r.stage && TEAM_STEP[r.stage]) ?? null,
    round: local && r.round >= 1 ? r.round : null, since: local && r.since > 0 ? r.since : null, reason: r.reason, code: local ? r.code : null, stage: null, team: !local };
}

const legacyFacts = (stage: string): TaskWorkFacts =>
  ({ column: 'legacy', who: null, lent: false, machine: null, family: null, step: null, round: null, since: null, reason: null, code: null, stage, team: false });

/**
 * 卡号 → 快照里的事实。board 为 null（快照还没到）返回 undefined；快照里没有这张卡返回 null。
 * team = 团队板（TeamWorkBoard）；localInstance = 本机在这条团队绑定上的实例 id（主场本机的团队行据此认出、不算数）
 */
export function taskWorkFacts(board: WorkBoard | TeamWorkBoard | null, team: boolean, id: string, localInstance: string | null = null): TaskWorkFacts | null | undefined {
  if (!board) return undefined;
  const cols = team ? board as TeamWorkBoard : localColumns(board as WorkBoard);
  for (const col of COLUMNS) {
    const r = cols[col].find((x) => x.taskId === id);
    if (!r) continue;
    if (!isLocalRow(r) && localInstance && r.instance === localInstance) return null;
    return rowFacts(r, col);
  }
  const old = board.legacy?.find((x) => x.taskId === id);
  return old ? legacyFacts(old.stage) : null;
}

/** use-dag-panes.tsx 返回的按卡号查询（collab-view.tsx 传给 CollabDetail） */
export type WorkFactsOf = (id: string) => TaskWorkFacts | null | undefined;
export function workFactsOf(work: { kind: 'local' | 'team'; board: WorkBoard | TeamWorkBoard | null }, project: string): WorkFactsOf {
  const localInstance = sharedIdentity(project)?.homeInstanceId ?? null;
  return (id) => taskWorkFacts(work.board, work.kind === 'team', id, localInstance);
}
