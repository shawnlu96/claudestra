/** `manager project-decl-scan`: AI declaration draft + confirmation PR (lib/project-decl-scan.ts). Output carries no local path. */
import { readFileSync } from "node:fs";
import { PROJECTS_PATH, type ProjectDef } from "../lib/projects.js";
import { parseProjectJson } from "../lib/project-decl-schema.js";
import { scanProjectDeclaration, type ProjectDeclScanOptions } from "../lib/project-decl-scan.js";
import { outputSync } from "./core.js";

const USAGE = "manager project-decl-scan <project> [repoDir] [targetBranch] [--without-ai] [--rescan]";
interface ScanCommandPorts {
  projectsPath?: string; output?: (value: unknown) => void; exitCode?: (code: number) => void;
  scan?: (o: ProjectDeclScanOptions) => ReturnType<typeof scanProjectDeclaration>;
}

function selectProject(path: string, id: string): ProjectDef | null {
  try {
    const list = (parseProjectJson(readFileSync(path, "utf8")) as { projects?: unknown })?.projects;
    const hits = Array.isArray(list) ? list.filter((p: ProjectDef) => p?.id === id) : [];
    const ok = hits.length === 1 && Array.isArray(hits[0].dirs) && hits[0].dirs.length > 0 && hits[0].dirs.every((d: unknown) => typeof d === "string");
    return ok ? hits[0] : null;
  } catch {
    return null; // parse / filesystem errors may quote local paths: the caller reports a fixed reason instead
  }
}

export async function cmdProjectDeclScan(args: string[], ports: ScanCommandPorts = {}): Promise<void> {
  const out = ports.output ?? ((value) => outputSync(JSON.stringify(value, null, 2)));
  const exit = ports.exitCode ?? ((code) => { process.exitCode = code; });
  const flags = args.filter((a) => a.startsWith("--")), positional = args.filter((a) => !a.startsWith("--"));
  const [projectId, repoDir, targetBranch] = positional;
  if (!projectId || positional.length > 3 || flags.some((f) => f !== "--without-ai" && f !== "--rescan")) {
    out({ ok: false, reasonCode: "INVALID_ARGUMENTS", usage: USAGE }); exit(2); return;
  }
  const project = selectProject(ports.projectsPath ?? PROJECTS_PATH, projectId);
  if (!project) { out({ ok: false, reasonCode: "INVALID_PROJECT_CONFIG" }); exit(2); return; }
  if (!repoDir && project.dirs.length !== 1) { out({ ok: false, reasonCode: "REPOSITORY_SELECTION_REQUIRED" }); exit(2); return; }
  const result = await (ports.scan ?? scanProjectDeclaration)({ project, repoDir: repoDir ?? project.dirs[0], targetBranch,
    ai: !flags.includes("--without-ai"), rescan: flags.includes("--rescan") });
  const ok = ["observed", "created", "existing"].includes(result.status);
  out({ ok, ...result }); exit(ok ? 0 : 2);
}

// Dispatched from the first manager imports; top-level await holds manager's own evaluation until this command has finished.
if (process.argv[2] === "project-decl-scan") {
  await cmdProjectDeclScan(process.argv.slice(3));
  process.exit(process.exitCode ?? 0);
}
