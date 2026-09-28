/**
 * 协作视图开没开、看的是哪个项目的哪条任务。独立的小 store，不进 chat-store（那边 guard 基线已顶格）。
 * 主区域（main-body.tsx）按它决定显示聊天还是协作视图；点侧栏的 agent 行会 closeCollab 回到聊天。
 */
import { useSyncExternalStore } from "react";

export interface CollabNav {
  project: string | null;
  task: string | null;
}

let state: CollabNav = { project: null, task: null };
const subs = new Set<() => void>();

function set(next: CollabNav) {
  if (next.project === state.project && next.task === state.task) return;
  state = next;
  for (const cb of subs) cb();
}

export const openCollab = (project: string) => set({ project, task: state.project === project ? state.task : null });
export const closeCollab = () => set({ project: null, task: null });
export const openCollabTask = (task: string | null) => set({ ...state, task });

export function useCollabNav(): CollabNav {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => state,
    () => state,
  );
}
