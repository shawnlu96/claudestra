import { join } from "node:path";
import { isPersonalProject } from "./lend-policy.js";
import { readJsonStateSync } from "./state-file.js";
import { STATE_DIR } from "./paths.js";
import { PROJECT_ID_RE, type ProjectDef } from "./projects.js";
import type { SharedLedgerBinding } from "./shared-ledger-gate-bindings.js";

/** Security decisions use the current file, never the project reader's last-good cache. */
function sharedLedgerLinkProjects(dir = STATE_DIR): ProjectDef[] {
  const state = readJsonStateSync(join(dir, "projects.json"), value => {
    const ps = (value as { projects?: ProjectDef[] } | null)?.projects;
    return Array.isArray(ps) && ps.every(p => p && PROJECT_ID_RE.test(p.id) && typeof p.name === "string"
      && Array.isArray(p.dirs) && p.dirs.every(d => typeof d === "string")
      && (p.personal === undefined || typeof p.personal === "boolean")) && new Set(ps.map(p => p.id)).size === ps.length;
  });
  if (state.status === "missing") return [];
  if (state.status !== "ok") throw new Error("invalid local projects; nothing was saved");
  return (state.data as { projects: ProjectDef[] }).projects;
}

export function requireSharedLedgerLinkTarget(localProjectId: string, dir = STATE_DIR): void {
  const project = sharedLedgerLinkProjects(dir).find(p => p.id === localProjectId);
  if (!project) throw new Error("local project does not exist; nothing was saved");
  if (isPersonalProject(project)) throw new Error("personal project cannot be bound; nothing was saved");
}

export const sharedLedgerBindingLocalId = (binding: SharedLedgerBinding): string => binding.localProjectId ?? binding.projectId;
export const sameSharedLedgerProject = (a: SharedLedgerBinding, b: SharedLedgerBinding): boolean =>
  a.centerId === b.centerId && a.teamId === b.teamId && a.projectId === b.projectId;

