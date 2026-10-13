'use client';
import type { Tr } from '../collab-model';
import { useTeamWorkBoard, useWorkBoard } from './use-work-board';
import type { TeamWorkBoard } from './work-types';
import { WorkBoardContent } from './work-board-content';

export { WorkBoardContent } from './work-board-content';

/** 本机「谁在干活」= 取数（use-work-board.ts，请求 / 重试 / 刷新节奏）+ 纯展示（work-board-content.tsx，团队视图也用它） */
interface Props { project: string; tr: Tr; onNode: (featureId: string, nodeKey: string) => void; onTask: (taskId: string) => void }
export function WorkBoardView(props: Props) {
  const load = useWorkBoard(props.project);
  return <WorkBoardContent {...props} board={load.board} retrying={load.retrying} />;
}

/**
 * 团队视图的「谁在干活」：只在这个标签打开时挂载，主场本机的本机 /work 与快照名字才去读（use-work-board.ts useTeamWorkBoard）；
 * 放在 use-dag-panes 里会让打开团队视图就探本机台账（tests/web-collab-unified-browser.test.ts 不探本机台账）
 */
interface TeamProps extends Props { team: TeamWorkBoard | null }
export function TeamWorkBoardView({ team, ...props }: TeamProps) {
  const load = useTeamWorkBoard(props.project, team);
  return <WorkBoardContent {...props} team board={load.board} retrying={load.retrying} />;
}
