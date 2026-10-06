import { join } from "node:path";
import { isPersonalProject } from "./lend-policy.js";
import { readJsonStateSync } from "./state-file.js";
import { STATE_DIR } from "./paths.js";
import { PROJECT_ID_RE, slugifyProjectId, type ProjectDef, type ProjectsData } from "./projects.js";
import type { SharedLedgerBinding } from "./shared-ledger-gate-bindings.js";

/** Security decisions use the current file, never the project reader's last-good cache. */
export function readSharedLedgerProjects(dir = STATE_DIR): ProjectsData {
  const state = readJsonStateSync(join(dir, "projects.json"), value => {
    const ps = (value as { projects?: ProjectDef[] } | null)?.projects;
    return Array.isArray(ps) && ps.every(p => p && PROJECT_ID_RE.test(p.id) && typeof p.name === "string"
      && Array.isArray(p.dirs) && p.dirs.every(d => typeof d === "string")
      && (p.personal === undefined || typeof p.personal === "boolean")) && new Set(ps.map(p => p.id)).size === ps.length;
  });
  if (state.status === "missing") return { projects: [] };
  if (state.status !== "ok") throw new Error("invalid local projects; nothing was saved");
  return state.data as ProjectsData;
}

export function requireSharedLedgerProject(localProjectId: string, dir = STATE_DIR): ProjectDef {
  const project = readSharedLedgerProjects(dir).projects.find(p => p.id === localProjectId);
  if (!project) throw new Error("local project does not exist; nothing was saved");
  if (isPersonalProject(project)) throw new Error("personal project cannot be bound; nothing was saved");
  return project;
}

export { requireSharedLedgerProject as requireSharedLedgerLinkTarget };

export const sharedLedgerBindingLocalId = (binding: SharedLedgerBinding): string => binding.localProjectId ?? binding.projectId;
export const sameSharedLedgerProject = (a: SharedLedgerBinding, b: SharedLedgerBinding): boolean =>
  a.centerId === b.centerId && a.teamId === b.teamId && a.projectId === b.projectId;


export interface SharedLedgerProjectDisplay { teamId: string; projectId: string; name: string }

/** Allocate the local slug after the enrollment adapter verifies the center's display. */
export function newSharedLedgerProject(project: SharedLedgerProjectDisplay, dir = STATE_DIR): ProjectDef {
  if (!PROJECT_ID_RE.test(project.projectId) || !project.name.trim() || project.name.length > 64) throw new Error("invalid shared project display");
  return { id: slugifyProjectId(project.projectId, new Set(readSharedLedgerProjects(dir).projects.map(p => p.id))),
    name: project.name, dirs: [], createdAt: new Date().toISOString() };
}
