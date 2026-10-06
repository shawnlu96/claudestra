import { PROJECT_ID_RE } from "../../lib/projects.js";
import type { AskRow } from "../../lib/ask-options.js";
import type { SharedLedgerBinding } from "../../lib/shared-ledger-gate-bindings.js";
import type { JoinOfferProject } from "../../lib/shared-ledger-join-offer.js";
import type { ProjectSelection } from "./shared-projects-ports.js";

const PROJECT_SELECT = "shared_project_local";
export interface ProjectChoice { value: string; name: string; selection: ProjectSelection }

/** Input is the non-personal project list. Bound projects never become candidates, including same-center bindings. */
export function projectChoices(project: JoinOfferProject, projects: { id: string; name: string }[], bindings: SharedLedgerBinding[]) {
  const eligible = projects.filter(p => PROJECT_ID_RE.test(p.id) && !bindings.some(b => (b.localProjectId ?? b.projectId) === p.id));
  const matches = eligible.filter(p => p.id.toLowerCase() === project.projectId.toLowerCase() || p.name.toLowerCase() === project.name.toLowerCase());
  const choices: ProjectChoice[] = [
    { value: "create", name: "新建本地项目", selection: { mode: "create" } },
    ...eligible.map(p => ({ value: `local_${p.id}`, name: p.name, selection: { mode: "existing" as const, localProjectId: p.id } })),
  ];
  const recommended = matches.length === 1 ? `local_${matches[0]!.id}` : "create";
  const row: AskRow = { type: "select", id: PROJECT_SELECT, min: 1, max: 1, placeholder: "选择本机项目", options: choices.map(c => ({
    value: c.value, label: `${c.name}${c.value === recommended ? "（推荐）" : ""}`,
  })) };
  return { choices, recommended, row };
}

/** A recommended choice is never consent; require exactly one explicit select value plus the separate approval button. */
export function selectedProject(wires: string[], choices: ProjectChoice[]): ProjectSelection | null {
  const selected = wires.filter(w => w.startsWith(`[select:${PROJECT_SELECT}:`));
  if (selected.length !== 1) return null;
  return choices.find(c => selected[0] === `[select:${PROJECT_SELECT}:${c.value}]`)?.selection ?? null;
}
