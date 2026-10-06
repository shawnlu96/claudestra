import { join } from "node:path";
import { readJsonStateSync } from "./state-file.js";
import { PROJECT_ID_RE, slugifyProjectId, type ProjectDef, type ProjectsData } from "./projects.js";
import { isPersonalProject } from "./lend-policy.js";
import { STATE_DIR } from "./paths.js";
import type { SharedLedgerBinding } from "./shared-ledger-gate-bindings.js";

export interface SharedLedgerProjectDisplay { teamId: string; projectId: string; name: string }

/** Authorization must not fall back to the projects reader's last-good cache. */
export function readSharedLedgerProjects(dir = STATE_DIR): ProjectsData {
  const state = readJsonStateSync(join(dir, "projects.json"), (v) => {
    const projects = (v as ProjectsData | null)?.projects;
    return Array.isArray(projects) && projects.every(p => p && typeof p.id === "string"
      && typeof p.name === "string" && Array.isArray(p.dirs) && p.dirs.every(d => typeof d === "string"));
  });
  if (state.status === "corrupt") throw new Error("invalid local projects; nothing was saved");
  return state.status === "missing" ? { projects: [] } : state.data as ProjectsData;
}

export function requireSharedLedgerProject(localProjectId: string, dir = STATE_DIR): ProjectDef {
  const project = readSharedLedgerProjects(dir).projects.find(p => p.id === localProjectId);
  if (!project || isPersonalProject(project)) throw new Error("local project missing or personal; nothing was saved");
  return project;
}

export function sameSharedLedgerProject(a: SharedLedgerBinding, b: SharedLedgerBinding): boolean {
  return a.centerId === b.centerId && a.teamId === b.teamId && a.projectId === b.projectId;
}

/** Both directions are unique, including legacy rows that implicitly use the center project id. */
export function assertSharedLedgerBindingAvailable(next: SharedLedgerBinding, current: SharedLedgerBinding[]): void {
  const local = next.localProjectId ?? next.projectId;
  if (current.some(b => sameSharedLedgerProject(b, next) ? (b.localProjectId ?? b.projectId) !== local
    : (b.localProjectId ?? b.projectId) === local)) throw new Error("project already bound; nothing was saved");
}

export function newSharedLedgerProject(project: SharedLedgerProjectDisplay, dir = STATE_DIR): ProjectDef {
  if (!PROJECT_ID_RE.test(project.projectId) || !project.name.trim() || project.name.length > 64) throw new Error("invalid shared project display");
  return { id: slugifyProjectId(project.projectId, new Set(readSharedLedgerProjects(dir).projects.map(p => p.id))),
    name: project.name, dirs: [], createdAt: new Date().toISOString() };
}

/** Validate the proposed result before any projects, registry or bindings write. */
export function sharedLedgerProjectMutationError(bindings: SharedLedgerBinding[], ids: string[], next?: ProjectDef): string | null {
  const bound = bindings.some(b => ids.includes(b.localProjectId ?? b.projectId));
  if (bound && (ids.length > 1 || !next || isPersonalProject(next))) return "项目已绑定团队项目，请先退出团队项目";
  return null;
}
