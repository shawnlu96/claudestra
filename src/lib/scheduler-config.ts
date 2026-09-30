/** Local scheduler policy; missing or invalid config keeps the fourth daemon idle. */
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { statePath } from "./paths.js";

export const SCHEDULER_CONFIG_PATH = statePath("scheduler.json");
interface ProjectSchedule {
  maxActiveWorkers: number;
  requiredChecks: string[];
  /** Local clone whose `gh` context must match the PR repository; the scheduler never deploys from it. */
  repoDir: string;
}
export interface SchedulerConfig {
  enabled: boolean;
  pollMs: number;
  projects: Record<string, ProjectSchedule>;
}

/** Invalid config is an explicit error, never a partial activation with guessed defaults. */
export function parseSchedulerConfig(raw: unknown): SchedulerConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("scheduler config must be an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== "boolean") throw new Error("scheduler.enabled must be boolean");
  const pollMs = r.pollMs === undefined ? 5000 : r.pollMs;
  if (!Number.isInteger(pollMs) || (pollMs as number) < 1000 || (pollMs as number) > 60_000) throw new Error("scheduler.pollMs must be 1000..60000");
  if (!r.projects || typeof r.projects !== "object" || Array.isArray(r.projects)) throw new Error("scheduler.projects must be an object");
  const projects: Record<string, ProjectSchedule> = {};
  for (const [id, value] of Object.entries(r.projects)) {
    if (!/^[\w.-]{1,80}$/.test(id) || !value || typeof value !== "object") throw new Error(`invalid scheduler project ${id}`);
    const p = value as Record<string, unknown>;
    if (!Number.isInteger(p.maxActiveWorkers) || (p.maxActiveWorkers as number) < 1 || (p.maxActiveWorkers as number) > 32) {
      throw new Error(`scheduler project ${id} needs maxActiveWorkers 1..32`);
    }
    if (!Array.isArray(p.requiredChecks) || p.requiredChecks.length < 1 || p.requiredChecks.length > 20 ||
      p.requiredChecks.some((x) => typeof x !== "string" || !/^[\w .:/-]{1,80}$/.test(x))) {
      throw new Error(`scheduler project ${id} needs 1..20 requiredChecks names`);
    }
    // Refusing beats ignoring: a config written for automatic deployment must not silently run merge-only.
    if (p.deploy !== undefined) throw new Error(`scheduler project ${id}: automatic deploy is not supported (T68g); remove deploy, the PM deploys`);
    if (typeof p.repoDir !== "string" || !isAbsolute(p.repoDir) || /[\p{Cc}\p{Cf}]/u.test(p.repoDir)) {
      throw new Error(`scheduler project ${id} needs absolute repoDir`);
    }
    projects[id] = { maxActiveWorkers: p.maxActiveWorkers as number, requiredChecks: [...new Set(p.requiredChecks as string[])],
      repoDir: p.repoDir };
  }
  if (r.enabled && Object.keys(projects).length === 0) throw new Error("enabled scheduler needs at least one project");
  return { enabled: r.enabled, pollMs: pollMs as number, projects };
}

export function readSchedulerConfig(path = SCHEDULER_CONFIG_PATH): SchedulerConfig {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false, pollMs: 5000, projects: {} };
    throw e;
  }
  return parseSchedulerConfig(JSON.parse(raw));
}
