/** Local scheduler policy; missing or invalid config keeps the fourth daemon idle. */
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isPriority, PRIORITIES, REPO_RE, type Priority } from "./lend-config.js";
import { statePath } from "./paths.js";
import { parseWriteFamilies } from "./scheduler-family-pick.js";

export const SCHEDULER_CONFIG_PATH = statePath("scheduler.json");
/**
 * Shared slot pool (i28-W5, lib/scheduler-placement.ts): balance = local and usable peers share the ready nodes by tier
 * (localPriority here, `priority` on each borrow entry: first → balance → low, off never; i28-W9), fewest running first;
 * off = local only. overflow / prefer are i28-R9's spellings: parsing reads them as balance with a note instead of throwing
 * (a throw would switch the whole scheduler config off); a hand-built policy that still says them is treated as balance too.
 * roles: "review" and "write" (= build + fix, i28-W9); absent = review only. Writing needs `repo` (the GitHub owner/repo a
 * peer clones and pushes its lend/ branch to): a build card has no PR yet to take it from.
 */
type RemoteMode = "balance" | "off" | "overflow" | "prefer";
type RemoteRole = "review" | "write";
/** reviewFirst: peers that get every review they can take, in order, before the tiers (i28-W5c); absent = none. */
export interface RemotePolicy {
  mode: RemoteMode; roles: RemoteRole[]; poolTimeoutMin: number; reviewFirst?: string[]; writeFamilies?: ("claude" | "codex")[];
  /** This machine's tier; absent = balance. */
  localPriority?: Priority;
  /** Set exactly when roles holds "write". */
  repo?: string;
  note?: string;
}
export const DEFAULT_REMOTE: RemotePolicy = { mode: "balance", roles: ["review"], poolTimeoutMin: 15 };
export const isLegacyRemoteMode = (m: unknown): m is "overflow" | "prefer" => m === "overflow" || m === "prefer";

interface ProjectSchedule {
  /** 0 = no local worker at all (every eligible node goes to the pool; nothing else is dispatched). */
  maxActiveWorkers: number;
  /** Always set by parseSchedulerConfig (default DEFAULT_REMOTE); a hand-built policy without it never pools. */
  remote?: RemotePolicy;
  requiredChecks: string[];
  /** Local clone whose `gh` context must match the PR repository; with `deploy` it is also the tree that gets deployed. */
  repoDir: string;
  /** Absent = merge only, the PM deploys (T68g). */
  deploy?: DeployTarget;
  /** false = this project's agents are never supervised (i28-S1); absent = follow the global switch */
  supervise?: boolean;
}
/** Agent supervision (i28-S1, lib/agent-supervisor.ts): on unless scheduler.json says otherwise; stuckMin = silent-turn threshold. */
interface SuperviseConfig { enabled: boolean; stuckMin: number }
const DEFAULT_SUPERVISE: SuperviseConfig = { enabled: true, stuckMin: 20 };
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
  /** Always set by parseSchedulerConfig; a hand-built config without it never supervises. */
  supervise?: SuperviseConfig;
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
    if (!Number.isInteger(p.maxActiveWorkers) || (p.maxActiveWorkers as number) < 0 || (p.maxActiveWorkers as number) > 32) {
      throw new Error(`scheduler project ${id} needs maxActiveWorkers 0..32`);
    }
    const requiredChecks = parseRequiredChecks(p.requiredChecks);
    if (!requiredChecks) throw new Error(`scheduler project ${id} needs 1..20 requiredChecks names`);
    if (typeof p.repoDir !== "string" || !isAbsolute(p.repoDir) || /[\p{Cc}\p{Cf}]/u.test(p.repoDir)) {
      throw new Error(`scheduler project ${id} needs absolute repoDir`);
    }
    if (p.supervise !== undefined && typeof p.supervise !== "boolean") throw new Error(`scheduler project ${id}: supervise must be boolean`);
    projects[id] = { maxActiveWorkers: p.maxActiveWorkers as number, requiredChecks,
      repoDir: p.repoDir, remote: parseRemote(id, p.remote), ...(p.deploy !== undefined ? { deploy: parseDeployTarget(id, p.deploy) } : {}),
      ...(p.supervise !== undefined ? { supervise: p.supervise as boolean } : {}) };
  }
  if (r.enabled && Object.keys(projects).length === 0) throw new Error("enabled scheduler needs at least one project");
  return { enabled: r.enabled, pollMs: pollMs as number, autoDispatch: r.autoDispatch === true, projects, supervise: parseSupervise(r.supervise) };
}

/** `supervise: false` / `true` / `{ enabled?, stuckMin? }`; absent = DEFAULT_SUPERVISE */
function parseSupervise(raw: unknown): SuperviseConfig {
  if (raw === undefined) return { ...DEFAULT_SUPERVISE };
  if (typeof raw === "boolean") return { ...DEFAULT_SUPERVISE, enabled: raw };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("scheduler.supervise must be boolean or an object");
  const r = raw as Record<string, unknown>;
  if (r.enabled !== undefined && typeof r.enabled !== "boolean") throw new Error("scheduler.supervise.enabled must be boolean");
  const stuckMin = r.stuckMin ?? DEFAULT_SUPERVISE.stuckMin;
  if (!Number.isInteger(stuckMin) || (stuckMin as number) < 5 || (stuckMin as number) > 240) throw new Error("scheduler.supervise.stuckMin must be 5..240");
  return { enabled: r.enabled !== false, stuckMin: stuckMin as number };
}

function parseRemote(id: string, raw: unknown): RemotePolicy {
  if (raw === undefined) return { ...DEFAULT_REMOTE, roles: [...DEFAULT_REMOTE.roles] };
  return parseRemotePolicy(raw, `scheduler project ${id}: remote`);
}

/** One project's `remote`; also how `ledger scheduler-pool` rebuilds the policy the daemon passed (one parser, no copy). */
export function parseRemotePolicy(raw: unknown, where = "remote"): RemotePolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} must be an object`);
  const r = raw as Record<string, unknown>;
  const rawMode = r.mode ?? DEFAULT_REMOTE.mode;
  if (rawMode !== "off" && rawMode !== "balance" && !isLegacyRemoteMode(rawMode)) throw new Error(`${where}.mode must be balance|off`);
  const mode = isLegacyRemoteMode(rawMode) ? "balance" : rawMode;
  const roles = r.roles ?? DEFAULT_REMOTE.roles;
  if (!Array.isArray(roles) || roles.length > 2 || new Set(roles).size !== roles.length || roles.some((x) => x !== "review" && x !== "write")) {
    throw new Error(`${where}.roles takes "review" / "write" (write = build + fix), each once`);
  }
  const timeout = r.poolTimeoutMin ?? DEFAULT_REMOTE.poolTimeoutMin;
  if (!Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > 240) throw new Error(`${where}.poolTimeoutMin must be 1..240`);
  const first = r.reviewFirst === undefined ? [] : r.reviewFirst;
  if (!Array.isArray(first) || first.length > 8 || new Set(first).size !== first.length
    || first.some((x) => typeof x !== "string" || !x || /[\p{Cc}\p{Cf}]/u.test(x))) {
    throw new Error(`${where}.reviewFirst must be up to 8 distinct nonempty peer names`);
  }
  if (r.localPriority !== undefined && !isPriority(r.localPriority)) throw new Error(`${where}.localPriority must be ${PRIORITIES.join("|")}`);
  const writes = roles.includes("write");
  if (writes ? typeof r.repo !== "string" || !REPO_RE.test(r.repo) : r.repo !== undefined) {
    throw new Error(`${where}.repo (GitHub owner/repo) is required with roles "write" and only then`);
  }
  const note = isLegacyRemoteMode(rawMode) ? `remote.mode "${rawMode}" 是旧写法，按 balance 处理（i28-W5）` : undefined;
  return { mode, roles: (["review", "write"] as const).filter((x) => roles.includes(x)), poolTimeoutMin: timeout as number,
    ...(first.length ? { reviewFirst: first as string[] } : {}), ...(r.localPriority !== undefined ? { localPriority: r.localPriority as Priority } : {}),
    ...(writes ? { repo: r.repo as string } : {}), ...(note ? { note } : {}), ...parseWriteFamilies(r.writeFamilies, where) };
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
