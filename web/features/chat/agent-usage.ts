import { ApiError } from "@/lib/api/client";
import { fetchLedgerTask } from "@/lib/api/ledger";
import { openCollab, openCollabTask } from "@/features/collab/collab-nav";

/** Agents can move projects; resolve the historical task before opening the existing collaboration view. */
export async function openUsageTask(task: string, projects: string[], signal: AbortSignal): Promise<void> {
  for (const project of [...new Set(projects)]) {
    try {
      await fetchLedgerTask(project, task, signal);
      if (signal.aborted) return;
      openCollab(project);
      openCollabTask(task);
      return;
    } catch (error) {
      // Only absence permits searching the next project; transport/auth failures stay retryable in the UI.
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
    }
  }
  throw new Error("task no longer available");
}
