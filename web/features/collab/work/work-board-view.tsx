'use client';
import type { Tr } from '../collab-model';
import { useWorkBoard } from './use-work-board';
import { WorkBoardContent } from './work-board-content';

export { WorkBoardContent } from './work-board-content';

/** 本机「谁在干活」= 取数（use-work-board.ts，请求 / 重试 / 刷新节奏）+ 纯展示（work-board-content.tsx，团队视图也用它） */
interface Props { project: string; tr: Tr; onNode: (featureId: string, nodeKey: string) => void; onTask: (taskId: string) => void }
export function WorkBoardView(props: Props) {
  const load = useWorkBoard(props.project);
  return <WorkBoardContent {...props} board={load.board} retrying={load.retrying} />;
}
