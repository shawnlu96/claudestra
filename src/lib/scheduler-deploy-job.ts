/** Deployment belongs to launchd, so replacing the scheduler cannot reap its command tree. */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { statePath } from "./paths.js";
import { SRC_DIR } from "./repo-root.js";
import { resolveBunPath } from "./bun-path.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { runBounded } from "./run-bounded.js";
import type { MergeRun } from "./scheduler-merge.js";
import type { SchedulerConfig } from "./scheduler-config.js";

export interface DeployJob {
  intentId: string; mergeSha: string; taskId: string; prRef: string;
  label: string; cwd: string; argv: string[]; timeoutMs: number; createdAt: number;
  env: Record<string, string>;
}
type JobObservation = { status: "running" } | { status: "complete" } | { status: "unknown" | "failed"; reason: string };
export interface DeployJobs {
  submit(row: MergeRun, target: SchedulerConfig["projects"][string]["deploy"]): Promise<string>;
  observe(row: MergeRun): Promise<JobObservation>;
}
const safeText = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 500 && !/[\p{Cc}\p{Cf}]/u.test(s);

/** Persist only execution context, never inherited tokens or credentials. */
function deployEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SSH_AUTH_SOCK", "BRIDGE_PORT",
    "CLAUDESTRA_STATE_DIR", "CLAUDESTRA_RUNTIME_DIR", "CLAUDESTRA_SANDBOX", "CLAUDESTRA_SANDBOX_ROOT",
    "CLAUDESTRA_SANDBOX_DENY_DIRS", "CLAUDESTRA_SANDBOX_DENY_PORTS"]) if (env[key]) out[key] = env[key]!;
  return out;
}

export function readDeployJob(path: string): DeployJob {
  const raw = readJsonStateSync(path);
  if (raw.status !== "ok") throw new Error(`deployment request ${raw.status}`);
  const r = raw.data as DeployJob;
  if (!r || !safeText(r.intentId) || !/^[a-f0-9]{40}$/i.test(r.mergeSha) || !safeText(r.taskId) || !safeText(r.prRef) ||
    !/^com\.claudestra\.scheduler\.deploy\.[a-f0-9]{32}$/.test(r.label) || !safeText(r.cwd) || !isAbsolute(r.cwd) ||
    !Array.isArray(r.argv) || r.argv.length < 1 || r.argv.length > 32 || !r.argv.every(safeText) ||
    !Number.isInteger(r.timeoutMs) || r.timeoutMs < 1000 || r.timeoutMs > 3_600_000 || !Number.isFinite(r.createdAt) ||
    !r.env || Object.values(r.env).some((v) => typeof v !== "string")) throw new Error("invalid deployment request");
  return r;
}

/** The directory is an at-most-once claim. A crash before submit is unknown, never an automatic second deployment. */
export function deploymentJobs(opts: { root?: string; command?: typeof runBounded; now?: () => number } = {}): DeployJobs {
  const root = opts.root ?? statePath("scheduler-deploy"), command = opts.command ?? runBounded, now = opts.now ?? Date.now;
  const dirFor = (row: MergeRun) => join(root, createHash("sha256").update(row.intentId).digest("hex"));
  const requestFor = (row: MergeRun) => {
    const request = readDeployJob(join(dirFor(row), "request.json"));
    if (request.intentId !== row.intentId || request.mergeSha !== row.mergeSha || request.taskId !== row.taskId || request.prRef !== row.prRef) {
      throw new Error("deployment request identity changed");
    }
    return request;
  };
  return {
    async submit(row, target) {
      if (!row.mergeSha || !/^[a-f0-9]{40}$/i.test(row.mergeSha)) throw new Error("deployment needs confirmed merge SHA");
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const dir = dirFor(row);
      try { mkdirSync(dir, { mode: 0o700 }); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        return requestFor(row).label; // Existing claims are observed, never resubmitted after restart.
      }
      const label = `com.claudestra.scheduler.deploy.${createHash("sha256").update(dir).digest("hex").slice(0, 32)}`;
      const requestPath = join(dir, "request.json");
      writeJsonAtomicSync(requestPath, { intentId: row.intentId, mergeSha: row.mergeSha, taskId: row.taskId, prRef: row.prRef,
        label, cwd: target.cwd, argv: target.argv, timeoutMs: target.timeoutMs ?? 20 * 60_000, createdAt: now(), env: deployEnv(process.env) }, { mode: 0o600 });
      readDeployJob(requestPath);
      const inventory = await command(["/bin/launchctl", "list"], { timeoutMs: 10_000 });
      if (inventory.code !== 0 || inventory.timedOut || inventory.stdout.split("\n").some((line) => line.trim().split(/\s+/).at(-1) === label)) {
        throw new Error("cannot establish unused deployment launchd label");
      }
      const result = await command(["/bin/launchctl", "submit", "-l", label, "-o", join(dir, "stdout.log"), "-e", join(dir, "stderr.log"),
        "--", resolveBunPath(), "--no-env-file", join(SRC_DIR, "scheduler.ts"), "--deploy-job", requestPath], { timeoutMs: 10_000 });
      if (result.code !== 0 || result.timedOut) throw new Error(`deployment submit uncertain: ${result.stderr.slice(0, 300)}`);
      return label;
    },
    async observe(row) {
      const request = requestFor(row), result = readJsonStateSync(join(dirFor(row), "result.json"));
      if (result.status === "corrupt") return { status: "unknown", reason: "deployment result corrupt" };
      if (result.status === "ok") {
        const r = result.data as Record<string, unknown>;
        if (!r || r.intentId !== row.intentId || r.mergeSha !== row.mergeSha || typeof r.timedOut !== "boolean" ||
          (r.code !== null && !Number.isInteger(r.code))) return { status: "unknown", reason: "deployment result identity or format invalid" };
        return r.code === 0 && !r.timedOut ? { status: "complete" } : { status: "failed", reason: `deployment exit ${r.code}, timeout=${r.timedOut}` };
      }
      if (now() > request.createdAt + request.timeoutMs + 30_000) return { status: "unknown", reason: "deployment has no result after deadline" };
      const list = await command(["/bin/launchctl", "list"], { timeoutMs: 10_000 });
      const entry = list.stdout.split("\n").find((line) => line.trim().split(/\s+/).at(-1) === request.label)?.trim().split(/\s+/);
      if (list.code === 0 && !list.timedOut && entry && (entry[0] !== "-" || now() < request.createdAt + 10_000)) return { status: "running" };
      const late = readJsonStateSync(join(dirFor(row), "result.json"));
      if (late.status !== "missing") return this.observe(row); // Completion can land between the initial file read and launchctl inspection.
      return { status: "unknown", reason: "deployment job disappeared without durable result" };
    },
  };
}
