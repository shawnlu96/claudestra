/**
 * 协作视图开没开、看的是哪个项目的哪条任务。独立的小 store，不进 chat-store（那边 guard 基线已顶格）。
 * 主区域的覆盖层（collab-switch.tsx）按它决定盖不盖；点侧栏会话、通知直达都会 closeCollab 回到聊天。
 */
import { useSyncExternalStore } from "react";
import { holdReads } from "@/lib/api/push";

export interface CollabNav {
  project: string | null;
  task: string | null;
  /** "team" = the standalone team page for this local project (collab-switch renders RosterPage instead of the collab view). */
  view: "team" | null;
}

let state: CollabNav = { project: null, task: null, view: null };
/** 协作视图盖着期间被拦下的已读回执（关掉时由 collab-switch 判断要不要补发） */
const released: string[] = [];
export const takeReleasedReads = (): string[] => released.splice(0);
const subs = new Set<() => void>();

function set(next: CollabNav) {
  if (next.project === state.project && next.task === state.task && next.view === state.view) return;
  state = next;
  released.push(...holdReads(next.project !== null));
  for (const cb of subs) cb();
}

export const openCollab = (project: string) => set({ project, task: state.project === project ? state.task : null, view: null });
export const closeCollab = () => set({ project: null, task: null, view: null });
export const showTeamView = (project: string) => set({ project, task: null, view: "team" });
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
