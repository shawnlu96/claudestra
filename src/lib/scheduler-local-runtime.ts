/** Project-local author selection; absent configuration preserves the Claude launch arguments. */
import { readFileSync } from "node:fs";
import { acquireLock } from "./file-lock.js";
import { readSchedulerConfig, parseSchedulerConfig, SCHEDULER_CONFIG_PATH } from "./scheduler-config.js";
import { writeTextAtomicSync } from "./state-file.js";

import { parseLocalAuthorRuntime, type LocalAuthorRuntime } from "./scheduler-local-runtime-config.js";

export function localAuthorRuntime(project: string, path = SCHEDULER_CONFIG_PATH): LocalAuthorRuntime {
  return readSchedulerConfig(path).projects[project]?.localAuthorRuntime ?? "claude";
}

/** Shares the scheduler config writer's lock and atomic writer, preserving unrelated raw keys. */
export async function setLocalAuthorRuntime(project: string, runtime: LocalAuthorRuntime, path = SCHEDULER_CONFIG_PATH): Promise<void> {
  parseLocalAuthorRuntime(runtime);
  const lock = await acquireLock(`${path}.lock`);
  if (!lock) throw new Error("scheduler config busy; runtime unchanged");
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    parseSchedulerConfig(raw);
    if (!Object.hasOwn(raw.projects, project)) throw new Error(`unknown scheduler project ${project}`);
    raw.projects[project].localAuthorRuntime = runtime;
    parseSchedulerConfig(raw);
    writeTextAtomicSync(path, `${JSON.stringify(raw, null, 2)}\n`, { preserveMode: true, commitIf: lock.held });
  } finally { lock.release(); }
}

// Explicit local configuration entry point; importing this module never writes configuration.
if (import.meta.main) {
  const [project, runtime] = process.argv.slice(2);
  if (!project || runtime === undefined) throw new Error("usage: bun src/lib/scheduler-local-runtime.ts <project> <claude|codex>");
  const parsed = parseLocalAuthorRuntime(runtime)!;
  await setLocalAuthorRuntime(project, parsed);
  console.log(`${project}: localAuthorRuntime=${parsed}`);
}
