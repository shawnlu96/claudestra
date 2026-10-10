"use client";
import { UnreadPill } from "./unread-pill";
import { entriesUnread } from "../sidebar-unread";
import type { ReactNode } from "react";
import { useT } from "@/lib/i18n";
import type { SidebarEntry } from "../sidebar-entries";
import { DIRECTORY_FOLD_KEYS, type DirectoryScope } from "../sidebar-history";
import { usePersistedSet } from "../use-persisted-set";
import { Chevron } from "./project-group";

/** 一个目录（活 / 历史）的 project 组与派发者折叠状态，按设备记住 */
export interface DirectoryFolds {
  projects: Set<string>;
  toggleProject: (id: string) => void;
  teams: Set<string>;
  toggleTeam: (id: string) => void;
}

export function useDirectoryFolds(scope: DirectoryScope): DirectoryFolds {
  const [projects, toggleProject] = usePersistedSet(DIRECTORY_FOLD_KEYS[scope].projects);
  const [teams, toggleTeam] = usePersistedSet(DIRECTORY_FOLD_KEYS[scope].teams);
  return { projects, toggleProject, teams, toggleTeam };
}

/** lucide history */
function HistoryIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}

export function HistoryFold({ count, unread = 0, open, onToggle, children }: { count: number; unread?: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  const t = useT();
  if (!count) return null;
  return (
    <li className="mt-1 rounded-xl bg-base-300/15 p-1">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-[12px] font-medium text-base-content/45 transition-colors hover:bg-base-300/40 hover:text-base-content/70"
        aria-expanded={open}
        onClick={onToggle}
      >
        <Chevron open={open} />
        <span className="flex items-center gap-1">
          <HistoryIcon />
          {t("历史")}
        </span>
        <span className="ml-auto shrink-0 text-[11px] font-normal text-base-content/35">{count}</span>
        {!open && <UnreadPill count={unread} />}
      </button>
      {open && <ul className="ml-[13px] mt-0.5 flex list-none flex-col gap-0.5 border-l-2 border-base-content/10 pl-1.5 opacity-75">{children}</ul>}
    </li>
  );
}

/**
 * 默认目录：活目录在上，已停止的收进底部「历史」。活目录的折叠由调用方传入（大总管派出的也用它），
 * 历史目录用自己的折叠命名空间——同一 project 两边各开各的。
 */
export function SidebarDirectory({ activeEntries, historyEntries, historyCount, activeFolds, renderEntry }: {
  activeEntries: SidebarEntry[];
  historyEntries: SidebarEntry[];
  historyCount: number;
  activeFolds: DirectoryFolds;
  renderEntry: (e: SidebarEntry, folds: DirectoryFolds) => ReactNode;
}) {
  const historyFolds = useDirectoryFolds("history");
  const [openHistory, toggleHistory] = usePersistedSet("cstra_directory_history_open");
  return (
    <ul className="flex w-full list-none flex-col gap-0.5 p-0">
      {activeEntries.map((e) => renderEntry(e, activeFolds))}
      <HistoryFold unread={entriesUnread(historyEntries)} count={historyCount} open={openHistory.has("all")} onToggle={() => toggleHistory("all")}>
        {historyEntries.map((e) => renderEntry(e, historyFolds))}
      </HistoryFold>
    </ul>
  );
}
