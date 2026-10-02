import { join } from "node:path";
import type { StartEnv } from "./dag-tools-start.js";

export async function pickRepo(env: StartEnv, project: string, want: string | undefined): Promise<string | null> {
  const dirs = await env.projectDirs(project);
  if (want) return dirs.includes(want) && env.exists(join(want, ".git")) ? want : null;
  return dirs.find((d) => env.exists(join(d, ".git"))) ?? null;
}
