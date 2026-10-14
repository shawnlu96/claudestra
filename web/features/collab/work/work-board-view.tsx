'use client';
/**
 * 「谁在干活」= 纯展示 work-board-content.tsx。取数（本机 useWorkBoard / 团队 useTeamWorkBoard，use-work-board.ts）提到了
 * dag/use-dag-panes.tsx：标签与全站计数（count-words.ts）共用同一份看板，不重复请求。这里只留老入口的导出。
 */
export { WorkBoardContent } from './work-board-content';
