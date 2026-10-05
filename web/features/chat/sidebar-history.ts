/** Default navigation follows session status, so idle live sessions stay reachable.
 * Partition before building teams: stopped parents cannot hide or relocate live children.
 * History retains the original records for search and recovery; no session data is changed.
 */
import { buildSidebarEntries, buildTeams, type SidebarEntry } from "./sidebar-entries";
import type { AgentSession, ProjectMeta } from "./type";

export function isHistoryAgent(a: AgentSession): boolean {
  return a.status === "stopped";
}

export function buildSidebarDirectory(list: AgentSession[], meta: Map<string, ProjectMeta>, masterName?: string): {
  activeEntries: SidebarEntry[];
  underMaster: AgentSession[];
  historyEntries: SidebarEntry[];
  historyCount: number;
} {
  const live = list.filter((a) => !isHistoryAgent(a));
  const history = list.filter(isHistoryAgent);
  return {
    activeEntries: buildSidebarEntries(live, "", meta, masterName),
    underMaster: buildTeams(live, masterName).underMaster,
    // Do not attach stopped children to the separately rendered live master card.
    historyEntries: buildSidebarEntries(history, "", meta),
    historyCount: history.length,
  };
}

export type DirectoryScope = "active" | "history";
/** Fold preferences per directory: a project can be live and in history at once, and each group folds on its own.
 * Active keeps the original keys so existing preferences survive; history gets its own namespace (nothing is migrated or cleared).
 * projects / teams record what the user collapsed (default open); teamsOpen / workersOpen record what the user opened
 * (dispatchers with worker kids and the worker folds start collapsed). */
export const DIRECTORY_FOLD_KEYS: Record<DirectoryScope, { projects: string; teams: string; teamsOpen: string; workersOpen: string }> = {
  active: { projects: "cstra_proj_collapsed", teams: "cstra_team_collapsed", teamsOpen: "cstra_team_open", workersOpen: "cstra_worker_fold_open" },
  history: {
    projects: "cstra_history_proj_collapsed",
    teams: "cstra_history_team_collapsed",
    teamsOpen: "cstra_history_team_open",
    workersOpen: "cstra_history_worker_fold_open",
  },
};
