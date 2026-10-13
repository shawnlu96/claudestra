/**
 * 「谁在干活」四栏的合并与命名（team-project-UXWHO1），纯函数：
 * - 本机看板（/work）分四栏：合并相关的行（code 为 merge_queue / ci，或步骤是合并）移进「在等合并」，不改 src/lib/ledger-work-board.ts；
 * - 团队看板（team-work-model.ts）里执行实例 = 本机实例（团队键 homeInstanceId）且本机看板有同卡号的行，整行换成本机看板的行
 *   （执行者、步骤、轮次、已持续、等待原因、执行机器），按本机看板的栏放；卡号带 `~2` 这类去重后缀的对不上就保留团队行，不猜；
 * - 其余团队行的机器写成员机器名（team-instance-names.ts），成员代号像原始 id 的不显示。
 */
import { hexFree, instanceName, LOCAL_MACHINE, OTHER_MACHINE, type InstanceNames } from '../team-instance-names';
import type { TeamBoardRow, TeamWorkBoard, TeamWorkRow, WorkBoard, WorkColumns, WorkRow } from './work-types';

export const COLUMNS = ['working', 'merging', 'waiting'] as const;
type Column = typeof COLUMNS[number];
const MERGE_CODES: ReadonlySet<string> = new Set(['merge_queue', 'ci']);
const isLocalRow = (r: TeamBoardRow): r is WorkRow => 'since' in r;
const inMerge = (r: WorkRow) => r.step === 'merge' || (r.code !== null && MERGE_CODES.has(r.code));

/** 本机看板的三栏 → 四栏；在干活里的合并步骤（没有等待原因）就是正在合并 */
export function localColumns(b: Pick<WorkBoard, 'working' | 'waiting'>): WorkColumns<WorkRow> {
  const out: WorkColumns<WorkRow> = { working: [], merging: [], waiting: [] };
  for (const r of b.working) {
    if (inMerge(r)) out.merging.push({ ...r, reason: r.reason ?? '正在合并' });
    else out.working.push(r);
  }
  for (const r of b.waiting) out[inMerge(r) ? 'merging' : 'waiting'].push(r);
  return out;
}

/** 本机看板的机器键：local →「本机」，出借单是 peer 名原样 */
export const localMachine = (m: string): string => (m === 'local' ? LOCAL_MACHINE : hexFree(m) ?? OTHER_MACHINE);

const teamRows = (team: TeamWorkBoard): TeamWorkRow[] => COLUMNS.flatMap((c) => team[c]).filter((r): r is TeamWorkRow => !isLocalRow(r));

/** 至少有一张绑了卡的行主场在本机：只有这时才值得读本机 /work（一行都没有就不发请求） */
export const needsLocalBoard = (team: TeamWorkBoard | null, localInstance: string | null): boolean =>
  !!team && !!localInstance && teamRows(team).some((r) => r.taskId !== null && r.instance === localInstance);

/** 有执行实例不是本机的行：要读快照把实例换成 peer 名 */
export const needsNames = (team: TeamWorkBoard | null, localInstance: string | null): boolean =>
  !!team && teamRows(team).some((r) => r.instance !== null && r.instance !== localInstance);

export function mergeTeamWork(team: TeamWorkBoard, local: WorkBoard | null, localInstance: string | null, names: InstanceNames): TeamWorkBoard {
  const at = new Map<string, { col: Column; row: WorkRow }>();
  if (local && localInstance) {
    const cols = localColumns(local);
    for (const col of COLUMNS) for (const row of cols[col]) if (row.taskId) at.set(row.taskId, { col, row });
  }
  const named = (r: TeamWorkRow): TeamWorkRow => ({ ...r, who: hexFree(r.who), machine: instanceName(r.instance, names, localInstance) });
  const out: TeamWorkBoard = { ...team, working: [], merging: [], waiting: [], machines: {},
    todo: { ready: team.todo.ready.map(named), blocked: team.todo.blocked.map(named) } };
  for (const col of COLUMNS) for (const r of team[col]) {
    const hit = !isLocalRow(r) && r.taskId !== null && r.instance === localInstance ? at.get(r.taskId) : undefined;
    if (hit) out[hit.col].push({ ...hit.row, who: hexFree(hit.row.who), machine: localMachine(hit.row.machine) });
    else out[col].push(isLocalRow(r) ? r : named(r));
  }
  for (const r of out.working) if (r.machine) out.machines[r.machine] = (out.machines[r.machine] ?? 0) + 1;
  return out;
}
