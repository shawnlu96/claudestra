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
    const requiredChecks = parseRequiredChecks(p.requiredChecks);
    if (!requiredChecks) throw new Error(`scheduler project ${id} needs 1..20 requiredChecks names`);
    // Refusing beats ignoring: a config written for automatic deployment must not silently run merge-only.
    if (p.deploy !== undefined) throw new Error(`scheduler project ${id}: automatic deploy is not supported (T68g); remove deploy, the PM deploys`);
    if (typeof p.repoDir !== "string" || !isAbsolute(p.repoDir) || /[\p{Cc}\p{Cf}]/u.test(p.repoDir)) {
      throw new Error(`scheduler project ${id} needs absolute repoDir`);
    }
    projects[id] = { maxActiveWorkers: p.maxActiveWorkers as number, requiredChecks,
      repoDir: p.repoDir };
  }
  if (r.enabled && Object.keys(projects).length === 0) throw new Error("enabled scheduler needs at least one project");
  return { enabled: r.enabled, pollMs: pollMs as number, projects };
}

/**
 * The one check-name rule for scheduler.json and `scheduler-merge-begin`; two copies let config accept names the CLI refuses.
 * Names are compared verbatim (case and spaces) with `gh pr checks` job names such as "typecheck + test + guard".
 * A comma is refused because the merge journal and `--required-checks` store the list comma-joined;
 * padding is refused because it could never match and would park the PR in await_ci forever.
 */
export function parseRequiredChecks(list: unknown): string[] | null {
  if (!Array.isArray(list) || list.length < 1 || list.length > 20) return null;
  const ok = list.every((x) => typeof x === "string" && x.length >= 1 && x.length <= 80 && x === x.trim() && !x.includes(",") &&
    !/[\p{Cc}\p{Cf}]/u.test(x));
  return ok ? [...new Set(list as string[])] : null;
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
