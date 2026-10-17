/** Pure read command: bypass the legacy projects cache so corrupt local restrictions cannot reuse a previous grant. */
import { readFileSync } from "node:fs";
import { PROJECTS_PATH, type ProjectDef } from "../lib/projects.js";
import { loadProjectDeclaration } from "../lib/project-decl.js";
import { declarationDiagnostic, parseProjectJson } from "../lib/project-decl-schema.js";
import { outputSync } from "./core.js";

interface CommandPorts { projectsPath?: string; output?: (value: unknown) => void; exitCode?: (code: number) => void }
export function cmdProjectDecl(args: string[], ports: CommandPorts = {}): void {
  const out = ports.output ?? ((value) => outputSync(JSON.stringify(value, null, 2)));
  const exit = ports.exitCode ?? ((code) => { process.exitCode = code; });
  const [projectId, action, repoDir, targetBranch] = args;
  if (!projectId || !["show", "validate", "explain"].includes(action) || args.length > 4) {
    out({ ok: false, diagnostics: [declarationDiagnostic("INVALID_ARGUMENTS", "arguments", "none", null)],
      usage: "manager project-decl <project> show|validate|explain [repoDir] [targetBranch]" }); exit(2); return;
  }
  try {
    const raw = parseProjectJson(readFileSync(ports.projectsPath ?? PROJECTS_PATH, "utf8")) as { projects?: ProjectDef[] };
    if (!raw || !Array.isArray(raw.projects)) throw new Error("invalid_projects");
    const matches = raw.projects.filter((p: ProjectDef) => p?.id === projectId);
    const project = matches[0];
    if (matches.length !== 1 || !Array.isArray(project.dirs) || !project.dirs.length
      || project.dirs.some((d: unknown) => typeof d !== "string")) throw new Error("ambiguous_project");
    if (!repoDir && project.dirs.length !== 1) {
      out({ ok: false, diagnostics: [declarationDiagnostic("REPOSITORY_SELECTION_REQUIRED", "repoDir", "local", null)] }); exit(2); return;
    }
    const result = loadProjectDeclaration({ project, repoDir: repoDir ?? project.dirs[0], targetBranch });
    const redacted = JSON.parse(JSON.stringify(result, (key, value) => key === "argv" ? { argumentCount: value.length } : value));
    out({ ok: result.valid, action, ...redacted });
    exit(action === "validate" && !result.valid ? 2 : 0);
  } catch {
    // Report a fixed diagnostic: parse / filesystem errors could contain local paths or environment values.
    out({ ok: false, diagnostics: [declarationDiagnostic("INVALID_PROJECT_CONFIG", "projects", "local", null)] }); exit(2);
  }
}

// The first manager import dispatches this read-only family before legacy daemon imports can rotate logs.
if (process.argv[2] === "project-decl") {
  cmdProjectDecl(process.argv.slice(3));
  process.exit(process.exitCode ?? 0);
}
