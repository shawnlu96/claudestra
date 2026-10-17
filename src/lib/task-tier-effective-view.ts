/** Read-only settings projection; execution remains the authority for inheritance, policy and template availability. */
import { readProjects, type ProjectsData } from "./projects.js";
import { CARD_ROLES, type CardRole, type RoleModelFamily, type RoleModelRead, type RoleModelTable, roleModelOf } from "./role-model-settings.js";
import { resolveTierModel, taskTierMode, type TierResolved } from "./task-tier-models.js";
import { TASK_TIERS, tierLaunchable, type TaskTier } from "./task-tier-spec.js";

type EffectiveRow = { role: CardRole } & Record<RoleModelFamily, TierResolved | ReturnType<typeof roleModelOf>>;
type ProjectMode = ReturnType<typeof taskTierMode>;
type ProjectView = { mode: ProjectMode["mode"]; diagnostic?: never } | { mode?: never; diagnostic: string };
export interface TaskTierEffectiveView {
  effective: Record<TaskTier | "undeclared", EffectiveRow[]>;
  projects: Record<string, ProjectView>;
  templates: Record<TaskTier, boolean>;
}
export interface TaskTierViewDeps {
  projects: () => Promise<ProjectsData>;
  mode: (project: string) => ProjectMode;
}

/** A diagnostic means mode is unknown, even though the execution gate conservatively stops. Never display that stop as configured off. */
function projectMode(project: string, mode: TaskTierViewDeps["mode"]): ProjectView {
  try {
    const result = mode(project);
    return result.diagnostic ? { diagnostic: "task_tier_config_unavailable" } : { mode: result.mode };
  } catch {
    // The read view can still show the other projects; paths and underlying I/O errors stay out of the API response.
    return { diagnostic: "task_tier_config_unavailable" };
  }
}

/** Use the already-read table and its status, so corrupt/missing files resolve exactly as they do at launch. No writes or events. */
export async function taskTierEffectiveView(table: RoleModelTable, status: RoleModelRead["status"],
  deps: TaskTierViewDeps = { projects: readProjects, mode: taskTierMode }): Promise<TaskTierEffectiveView> {
  const read: RoleModelRead = status === "invalid" || status === "unreadable" ? { table, status, error: "config_unavailable" } : { table, status };
  const effective = Object.fromEntries(TASK_TIERS.map((tier) => [tier, CARD_ROLES.map((role) => ({ role,
    claude: resolveTierModel(read, tier, role, "claude"), codex: resolveTierModel(read, tier, role, "codex"),
  }))])) as TaskTierEffectiveView["effective"];
  effective.undeclared = CARD_ROLES.map((role) => ({ role,
    claude: roleModelOf(read, role, "claude"), codex: roleModelOf(read, role, "codex"),
  }));
  const { projects } = await deps.projects();
  return {
    effective,
    projects: Object.fromEntries(projects.map(({ id }) => [id, projectMode(id, deps.mode)])),
    templates: Object.fromEntries(TASK_TIERS.map((tier) => [tier, tierLaunchable(tier)])) as TaskTierEffectiveView["templates"],
  };
}
