/** Local scheduler policy; missing or invalid config keeps the fourth daemon idle. */
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { statePath } from "./paths.js";

export const SCHEDULER_CONFIG_PATH = statePath("scheduler.json");
interface ProjectSchedule {
  maxActiveWorkers: number;
  requiredChecks: string[];
  /** Local clone whose `gh` context must match the PR repository; with `deploy` it is also the tree that gets deployed. */
  repoDir: string;
  /** Absent = merge only, the PM deploys (T68g). */
  deploy?: DeployTarget;
}
/** Steps are fixed in code (lib/scheduler-deploy-steps.ts); only machine-specific parts live here, never in the repo. */
export interface DeployTarget {
  /** Relay deploy command, run only when the pulled commits touch web / relay code; absent = that step is reported as skipped. */
  relayArgv?: string[];
  restartLabels: string[];
  timeoutMs: number;
}
/** Same four as DAEMONS in cli-install.ts (tests/scheduler-config.test.ts pins it); order follows the PM's deploy script. */
export const DEFAULT_RESTART_LABELS = ["com.claudestra.bridge", "com.claudestra.cron", "com.claudestra.launcher", "com.claudestra.scheduler"];
export interface SchedulerConfig {
  enabled: boolean;
  pollMs: number;
  /** Auto cards are driven only when this is true; off by default until T68h re-checks the lease inside CLI subprocesses. */
  autoDispatch: boolean;
  projects: Record<string, ProjectSchedule>;
}

/** Invalid config is an explicit error, never a partial activation with guessed defaults. */
export function parseSchedulerConfig(raw: unknown): SchedulerConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("scheduler config must be an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== "boolean") throw new Error("scheduler.enabled must be boolean");
  if (r.autoDispatch !== undefined && typeof r.autoDispatch !== "boolean") throw new Error("scheduler.autoDispatch must be boolean");
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
    if (typeof p.repoDir !== "string" || !isAbsolute(p.repoDir) || /[\p{Cc}\p{Cf}]/u.test(p.repoDir)) {
      throw new Error(`scheduler project ${id} needs absolute repoDir`);
    }
    projects[id] = { maxActiveWorkers: p.maxActiveWorkers as number, requiredChecks,
      repoDir: p.repoDir, ...(p.deploy !== undefined ? { deploy: parseDeployTarget(id, p.deploy) } : {}) };
  }
  if (r.enabled && Object.keys(projects).length === 0) throw new Error("enabled scheduler needs at least one project");
  return { enabled: r.enabled, pollMs: pollMs as number, autoDispatch: r.autoDispatch === true, projects };
}

const argv = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= 32 &&
  v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 500 && !/[\p{Cc}\p{Cf}]/u.test(x));

/** A sandbox must name its own fake labels: restarting the real daemons from a test instance would hit production. */
function parseDeployTarget(id: string, raw: unknown, env = process.env): DeployTarget {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`scheduler project ${id}: deploy must be an object`);
  const d = raw as Record<string, unknown>;
  if (d.relayArgv !== undefined && !argv(d.relayArgv)) throw new Error(`scheduler project ${id}: deploy.relayArgv must be a nonempty argv`);
  if (d.restartLabels !== undefined && (!argv(d.restartLabels) || (d.restartLabels as string[]).some((l) => !/^[\w.-]{1,120}$/.test(l)))) {
    throw new Error(`scheduler project ${id}: deploy.restartLabels must be launchd labels`);
  }
  const labels = (d.restartLabels as string[] | undefined) ?? DEFAULT_RESTART_LABELS;
  if (env.CLAUDESTRA_SANDBOX === "1" && labels.some((l) => DEFAULT_RESTART_LABELS.includes(l))) {
    throw new Error(`scheduler project ${id}: a sandbox deploy must list its own restartLabels, never the production daemons`);
  }
  const timeoutMs = d.timeoutMs === undefined ? 40 * 60_000 : d.timeoutMs;
  if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 60_000 || (timeoutMs as number) > 3_600_000) {
    throw new Error(`scheduler project ${id}: deploy.timeoutMs must be 60000..3600000`);
  }
  return { ...(d.relayArgv ? { relayArgv: d.relayArgv as string[] } : {}), restartLabels: [...labels], timeoutMs: timeoutMs as number };
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
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false, pollMs: 5000, autoDispatch: false, projects: {} };
    throw e;
  }
  return parseSchedulerConfig(JSON.parse(raw));
}
