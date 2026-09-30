/**
 * The deploy runs as its own one-shot launchd job (bootstrapped plist, KeepAlive false), never as a scheduler child: restarting
 * the four daemons, or an update reloading them, cannot take it down (launchd reaps a job's whole responsibility chain, detach
 * or not; see DAEMONS in cli-install.ts). The job directory is an at-most-once claim; a job never reruns once `started` exists.
 * `observe` keeps two answers apart: the outcome (result.json) and whether the job may still be alive (launchd + the job's
 * maintenance lease). Only a checked "not alive" ends a deploy. Tests: tests/scheduler-deploy-job.test.ts.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { lockOwnedBy } from "./file-lock.js";
import { statePath } from "./paths.js";
import { SRC_DIR } from "./repo-root.js";
import { resolveBunPath } from "./bun-path.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { runBounded } from "./run-bounded.js";
import { DEPLOY_LABEL_PREFIX, type DeployRun } from "./scheduler-deploy.js";
import type { DeployTarget } from "./scheduler-config.js";

export interface DeployJob {
  intentId: string; mergeSha: string; taskId: string; prRef: string; label: string;
  repoDir: string; relayArgv: string[] | null; restartLabels: string[]; timeoutMs: number; createdAt: number;
  env: Record<string, string>;
}
type Liveness = "alive" | "dead" | "unreadable";
type JobView = { label: string; liveness: Liveness; result: { ok: boolean; summary: string } | null; corrupt?: string; deadline: number };
export interface DeployJobs {
  /** Returns the label; on an existing claim returns the claimed label without submitting again. */
  submit(run: DeployRun, repoDir: string, target: DeployTarget): Promise<string>;
  /** null only when there is no job directory and launchd confirms it has no job under the intent's label. */
  observe(run: DeployRun): Promise<JobView | null>;
  /** bootout: SIGTERMs a live job (its runBounded groups die with it) or unloads a finished one; true when the label is gone. */
  remove(label: string): Promise<boolean>;
}

/** The lease renews every 30 s (file-lock.ts); three missed renewals mean the holder is gone even if the lock was never reclaimed. */
const LEASE_FRESH_MS = 90_000;
const GRACE_MS = 60_000;
const safeText = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 500 && !/[\p{Cc}\p{Cf}]/u.test(s);
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Persist only execution context, never inherited tokens or credentials. */
function deployEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SSH_AUTH_SOCK", "BRIDGE_PORT",
    "CLAUDESTRA_STATE_DIR", "CLAUDESTRA_RUNTIME_DIR", "CLAUDESTRA_SANDBOX", "CLAUDESTRA_SANDBOX_ROOT",
    "CLAUDESTRA_SANDBOX_DENY_DIRS", "CLAUDESTRA_SANDBOX_DENY_PORTS"]) if (env[key]) out[key] = env[key]!;
  return out;
}

const argvOk = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length >= 1 && v.length <= max && v.every(safeText);

export function readDeployJob(path: string): DeployJob {
  const raw = readJsonStateSync(path);
  if (raw.status !== "ok") throw new Error(`deployment request ${raw.status}`);
  const r = raw.data as DeployJob;
  if (!r || !safeText(r.intentId) || !/^[a-f0-9]{40}$/i.test(r.mergeSha) || !safeText(r.taskId) || !safeText(r.prRef) ||
    !safeText(r.label) || !r.label.startsWith(DEPLOY_LABEL_PREFIX) || !/^[a-f0-9]{32}$/.test(r.label.slice(DEPLOY_LABEL_PREFIX.length)) ||
    !safeText(r.repoDir) || !isAbsolute(r.repoDir) || (r.relayArgv !== null && !argvOk(r.relayArgv, 32)) || !argvOk(r.restartLabels, 16) ||
    !Number.isInteger(r.timeoutMs) || r.timeoutMs < 1000 || r.timeoutMs > 3_600_000 || !Number.isFinite(r.createdAt) ||
    !r.env || Object.values(r.env).some((v) => typeof v !== "string")) throw new Error("invalid deployment request");
  return r;
}

function plist(job: DeployJob, dir: string, requestPath: string): string {
  const argv = [resolveBunPath(), "--no-env-file", join(SRC_DIR, "scheduler.ts"), "--deploy-job", requestPath];
  const env = Object.entries(job.env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${job.label}</string>
  <key>ProgramArguments</key><array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xml(job.repoDir)}</string>
  <key>EnvironmentVariables</key><dict>
${env}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>${xml(join(dir, "stdout.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(dir, "stderr.log"))}</string>
</dict></plist>
`;
}

/** Alive if the job holds a fresh maintenance lease or launchd runs it; dead only when both say no. */
async function liveness(dir: string, label: string, command: typeof runBounded, now: () => number): Promise<Liveness> {
  const lease = readJsonStateSync(join(dir, "lease.json"));
  if (lease.status === "ok") {
    const l = lease.data as { path?: unknown; token?: unknown };
    try {
      if (typeof l.path === "string" && typeof l.token === "string" && lockOwnedBy(l.path, l.token) &&
        now() - statSync(l.path).mtimeMs < LEASE_FRESH_MS) return "alive";
    } catch { /* 锁目录刚被释放：不能据此说活着，交给下面 launchd 判 */ }
  }
  const r = await command(["/bin/launchctl", "list", label], { timeoutMs: 10_000 });
  if (r.timedOut) return "unreadable";
  if (r.code === 0) return /"PID"\s*=\s*\d+/.test(r.stdout) ? "alive" : "dead";
  return r.code === 113 || /could not find/i.test(r.stderr) ? "dead" : "unreadable";
}

export function deploymentJobs(opts: { root?: string; command?: typeof runBounded; now?: () => number; uid?: number } = {}): DeployJobs {
  const root = opts.root ?? statePath("scheduler-deploy"), command = opts.command ?? runBounded, now = opts.now ?? Date.now;
  const domain = `gui/${opts.uid ?? process.getuid?.() ?? 0}`;
  const labelFor = (dir: string) => `${DEPLOY_LABEL_PREFIX}${createHash("sha256").update(dir).digest("hex").slice(0, 32)}`;
  const dirFor = (run: DeployRun) => join(root, createHash("sha256").update(run.intentId).digest("hex"));
  const requestFor = (run: DeployRun) => {
    const request = readDeployJob(join(dirFor(run), "request.json"));
    if (request.intentId !== run.intentId || request.mergeSha !== run.mergeSha || request.taskId !== run.taskId) throw new Error("deployment request identity changed");
    return request;
  };
  return {
    async submit(run, repoDir, target) {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const dir = dirFor(run);
      try { mkdirSync(dir, { mode: 0o700 }); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        return labelFor(dir); // An existing claim is observed, never submitted a second time.
      }
      const label = labelFor(dir);
      const job: DeployJob = { intentId: run.intentId, mergeSha: run.mergeSha, taskId: run.taskId, prRef: run.prRef, label, repoDir,
        relayArgv: target.relayArgv ?? null, restartLabels: target.restartLabels, timeoutMs: target.timeoutMs, createdAt: now(), env: deployEnv(process.env) };
      const requestPath = join(dir, "request.json"), plistPath = join(dir, "job.plist");
      writeJsonAtomicSync(requestPath, job, { mode: 0o600 });
      readDeployJob(requestPath);
      writeFileSync(plistPath, plist(job, dir, requestPath), { mode: 0o600 });
      const r = await command(["/bin/launchctl", "bootstrap", domain, plistPath], { timeoutMs: 15_000 });
      if (r.code !== 0 || r.timedOut) throw new Error(`launchctl bootstrap ${r.timedOut ? "timeout" : `exit ${r.code}`}: ${r.stderr.trim().slice(0, 200)}`);
      return label;
    },
    async observe(run) {
      const dir = dirFor(run);
      // A missing or unreadable request says nothing about the job: the label follows from the directory path (which
      // exists before the job does), launchd and the lease still answer for it, and the deadline counts as passed so a
      // live job gets booted out. Only "no directory and launchd has no such job" means never submitted.
      let request: Pick<DeployJob, "label" | "createdAt" | "timeoutMs">, badRequest: string | undefined;
      try { request = requestFor(run); }
      catch (e) {
        request = { label: labelFor(dir), createdAt: 0, timeoutMs: 0 };
        badRequest = `request.json 读不了：${(e as Error).message.slice(0, 120)}`;
        if (!existsSync(dir)) {
          const live = await liveness(dir, request.label, command, now);
          if (live === "dead") return null;
          return { label: request.label, liveness: live, result: null, corrupt: "部署任务目录丢失", deadline: 0 };
        }
      }
      const deadline = request.createdAt + request.timeoutMs + GRACE_MS;
      const read = () => readJsonStateSync(join(dir, "result.json"));
      const first = read(), live = await liveness(dir, request.label, command, now);
      // The job writes result.json before it gives up its lease; a result that appears while we looked is read again.
      const settled = first.status === "missing" && live === "dead" ? read() : first;
      if (settled.status === "missing") return { label: request.label, liveness: live, result: null, deadline, ...(badRequest ? { corrupt: badRequest } : {}) };
      if (settled.status !== "ok") return { label: request.label, liveness: live, result: null, corrupt: `result.json ${settled.status}`, deadline };
      const r = settled.data as { intentId?: unknown; mergeSha?: unknown; ok?: unknown; summary?: unknown };
      if (r.intentId !== run.intentId || r.mergeSha !== run.mergeSha || typeof r.ok !== "boolean") {
        return { label: request.label, liveness: live, result: null, corrupt: "result.json identity or format invalid", deadline };
      }
      return { label: request.label, liveness: live, result: { ok: r.ok, summary: String(r.summary ?? "").slice(0, 400) }, deadline };
    },
    async remove(label) {
      if (!label.startsWith(DEPLOY_LABEL_PREFIX)) throw new Error("refusing to remove a non-deploy label");
      const r = await command(["/bin/launchctl", "bootout", `${domain}/${label}`], { timeoutMs: 30_000 });
      // 3 / 113 = no such service: already gone, which is the goal.
      return !r.timedOut && (r.code === 0 || r.code === 3 || r.code === 113 || /could not find|no such process/i.test(r.stderr));
    },
  };
}
