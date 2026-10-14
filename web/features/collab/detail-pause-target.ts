import type { TaskDetail } from "./collab-detail-model";
import type { PauseTarget } from "@/lib/api/card-pause";
import { sharedIdentity } from "./team-source-key";

// Shared views rename duplicate card ids for display. Keep the original target on the exact home detail that authorized local actions.
const targets = new WeakMap<TaskDetail, PauseTarget>();
export function rememberDetailTarget(d: TaskDetail, project: string, id: string): void { targets.set(d, { project, id }); }
export function detailTarget(d: TaskDetail, project: string, away: boolean): PauseTarget | null {
  return away ? null : sharedIdentity(project) ? targets.get(d) ?? null : { project, id: d.task.id };
}
