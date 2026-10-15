import { createPrivateKey } from "node:crypto";
import { closeSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CONFIG_PATH, DEFAULT_RUNTIME_DIR, LOG_DIR, RUNTIME_DIR, STATE_DIR, TMUX_SOCK } from "../../paths.js";
import { stateDir } from "../../state-dir.js";
import { readRenamedEnv } from "../../floka-env/read.js";
import { readDotenvFileSync } from "../../env-file.js";
import { resolveBridgePort } from "../../bridge-url.js";
import { tmuxRawStrict } from "../../tmux-helper.js";
import { REPO_ROOT } from "../../repo-root.js";
import { resolveBunPath } from "../../bun-path.js";
import { readJsonStateSync } from "../../state-file.js";
import { confirmStopped } from "../../state-maintenance/probe.js";
import { object, renameMode } from "../../floka-config/values.js";
import { createServicePlan } from "../plan/index.js";
import type { ServicePlan } from "../plan/types.js";
import { LaunchdController, realRun } from "./host.js";
import { digest, ServiceStore, type Snapshot } from "./store.js";

export function rawConfig(): Record<string, unknown> {
  const r = readJsonStateSync(CONFIG_PATH);
  if (r.status === "corrupt") throw new Error("Configuration is corrupt; refusing maintenance");
  return r.status === "ok" ? object(r.data) : {};
}
export function modes(config: unknown): Record<string, string> {
  const r = object(object(config).rename);
  return Object.fromEntries(["services", "cli", "runtime", "config"].map(k => [k, renameMode(r[k])]));
}
function productionInput(home: string): Snapshot["input"] {
  return { home, repoRoot: REPO_ROOT, bunPath: resolveBunPath(), logDir: LOG_DIR, envPath: process.env.PATH ?? "/usr/bin:/bin",
    environment: { CLAUDESTRA_STATE_DIR: STATE_DIR, FLOKA_STATE_DIR: STATE_DIR, CLAUDESTRA_RUNTIME_DIR: RUNTIME_DIR, FLOKA_RUNTIME_DIR: RUNTIME_DIR } };
}
export function cliInstallPaths(home: string, config: unknown, searchPath = process.env.PATH ?? ""): string[] {
  const custom = object(object(config).rename).cliPaths;
  if (custom !== undefined && (!Array.isArray(custom) || !custom.every(p => typeof p === "string" && p.startsWith("/")))) {
    throw new Error("rename.cliPaths must contain absolute installation paths");
  }
  const found: string[] = [];
  for (const dir of searchPath.split(":")) for (const name of ["claudestra", "floka"]) {
    const path = join(resolve(dir), name);
    try {
      const st = statSync(path);
      if (st.isFile() && st.size < 256_000 && readFileSync(path, "utf8").includes("one-shot launcher (Claudestra-installed")) found.push(path);
    } catch (e) {
      if (!["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
    }
  }
  const paths = [".local/bin", ".bun/bin"].flatMap(dir => ["claudestra", "floka"].map(name => join(home, dir, name)))
    .concat(custom ?? [], found);
  for (const path of [...paths]) {
    if (["claudestra", "floka"].includes(basename(path))) paths.push(join(dirname(path), basename(path) === "claudestra" ? "floka" : "claudestra"));
  }
  return [...new Set(paths)];
}

/** Hash existing identity and inode-backed runtime paths; no identity is created or copied. */
export async function provePaths(input: Snapshot["input"]): Promise<string> {
  const e = input.environment;
  if (!e) throw new Error("Missing explicit state/runtime environment");
  const state = realpathSync(e.CLAUDESTRA_STATE_DIR!), runtime = realpathSync(e.CLAUDESTRA_RUNTIME_DIR!);
  if (state !== realpathSync(e.FLOKA_STATE_DIR!) || runtime !== realpathSync(e.FLOKA_RUNTIME_DIR!) ||
      state !== realpathSync(STATE_DIR) || runtime !== realpathSync(RUNTIME_DIR)) throw new Error("State/runtime paths disagree");
  const id = readFileSync(join(state, "instance-id")), key = readFileSync(join(state, "instance-key.pem"));
  if (!/^[\w-]{1,64}$/.test(id.toString().trim()) || createPrivateKey(key).asymmetricKeyType !== "ed25519") throw new Error("Invalid existing identity");
  const socket = statSync(join(runtime, basename(TMUX_SOCK)));
  if (!socket.isSocket()) throw new Error("Existing runtime socket is missing");
  await proveInstalledPaths(input, state, runtime);
  return digest({ state, runtime, identity: digest([id.toString("base64"), key.toString("base64")]), socket: `${socket.dev}:${socket.ino}` });
}

async function proveInstalledPaths(input: Snapshot["input"], state: string, runtime: string): Promise<void> {
  const global: Record<string, string> = {};
  for (const k of ["CLAUDESTRA_STATE_DIR", "FLOKA_STATE_DIR", "CLAUDESTRA_RUNTIME_DIR", "FLOKA_RUNTIME_DIR", "FLOKA_RENAME_ENV", "NODE_ENV"]) {
    const r = await realRun(["launchctl", "getenv", k]);
    if (r.code !== 0 && r.code !== 1) throw new Error("Cannot prove launchd inherited paths");
    if (r.stdout.trim()) global[k] = r.stdout.trim();
  }
  for (const name of ["bridge", "cron", "scheduler", "launcher"]) {
    const path = join(input.home, "Library/LaunchAgents", `com.claudestra.${name}.plist`);
    const parsed = await realRun(["plutil", "-convert", "json", "-o", "-", path]);
    if (parsed.code !== 0) throw new Error("Cannot read original daemon configuration for path proof");
    const job = JSON.parse(parsed.stdout), directory = job.WorkingDirectory;
    if (job.Label !== `com.claudestra.${name}` || typeof directory !== "string") throw new Error("Original daemon identity is unknown");
    const mode = job.EnvironmentVariables?.NODE_ENV ?? global.NODE_ENV ?? "development";
    if (!["development", "production", "test"].includes(mode)) throw new Error("Unknown original daemon environment mode");
    const dotenv = Object.assign({}, ...[".env", `.env.${mode}`, ".env.local"].map(n => readDotenvFileSync(join(directory, n)) ?? {}));
    if (dotenv.NODE_ENV && dotenv.NODE_ENV !== mode) throw new Error("Ambiguous original daemon dotenv mode");
    const env = { ...dotenv, ...global, ...object(job.EnvironmentVariables) };
    if (env.HOME !== input.home || realpathSync(stateDir(env)) !== state ||
        realpathSync(readRenamedEnv("RUNTIME_DIR", env)?.trim() || DEFAULT_RUNTIME_DIR) !== runtime) {
      throw new Error(`Original daemon state/runtime differs: ${name}`);
    }
  }
}

/** Reuse STATE2's two scans. Already-running target jobs are permitted when resuming a partial switch. */
async function stoppedProof(root: string, plan: ServicePlan, host: LaunchdController): Promise<void> {
  const allowed = new Set<number>();
  const server = Number((await tmuxRawStrict(["display-message", "-p", "#{pid}"])).trim());
  if (!Number.isSafeInteger(server) || server <= 0) throw new Error("Cannot prove the existing tmux server identity");
  allowed.add(server); // The unchanged runtime server stays; its sessions and every other writer must stop.
  for (const s of plan.services) {
    const state = await host.inspect(plan, s, "new");
    for (const pid of state.pids ?? []) allowed.add(pid);
  }
  const run: typeof realRun = async (cmd, timeout) => {
    const r = await realRun(cmd, timeout);
    if (cmd[0] === "ps") r.stdout = r.stdout.split("\n").filter(l => !allowed.has(Number(l.trim().split(/\s+/)[0]))).join("\n");
    if (cmd[0] === "lsof") {
      let pid = 0;
      r.stdout = r.stdout.split("\n").filter(l => { if (l.startsWith("p")) pid = Number(l.slice(1)); return !allowed.has(pid); }).join("\n");
    }
    return r;
  };
  const canary = join(root, "services-canary");
  writeFileSync(canary, "", { mode: 0o600 });
  const fd = openSync(canary, "r");
  try {
    const problems = await confirmStopped({ run, selfPid: process.pid, uid: process.getuid?.() ?? -1,
      labels: plan.services.map(s => s.oldLabel).concat(plan.legacyLabels), canaryPath: canary, recordedPids: () => [], sleep: ms => Bun.sleep(ms) },
    [STATE_DIR, RUNTIME_DIR], 1_000);
    if (problems.length) throw new Error(`停写证明未通过: ${problems.join(";")}`);
  } finally { closeSync(fd); }
}

export function productionHost(root: string, home: string, txId: string): { host: LaunchdController; input: Snapshot["input"]; plan: ServicePlan } {
  const input = productionInput(home), plan = createServicePlan(txId, input);
  const host = new LaunchdController({ root, home, uid: process.getuid?.() ?? -1, run: realRun,
    beforeFirstLoad: async () => {
      await stoppedProof(root, plan, host);
      const saved = new ServiceStore(root).active();
      if (!saved?.proof || await provePaths(saved.input) !== saved.proof) throw new Error("Identity/runtime changed after stopping writers");
    }, health: async (service, side) => {
      if (service.name !== "bridge") return true;
      const env = readDotenvFileSync(join(input.repoRoot, ".env"));
      if (!env) return false;
      const port = resolveBridgePort(env), state = await host.inspect(plan, service, side);
      const listeners = await realRun(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
      const pids = listeners.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
      if (listeners.code !== 0 || !pids.length || pids.some(pid => !state.pids?.includes(pid))) return false;
      try { return (await fetch(`http://127.0.0.1:${port}/stats`, { signal: AbortSignal.timeout(2_000) })).ok; }
      catch { return false; } // A timeout or connection error is failed health, never permission to commit.
    } });
  return { host, input, plan };
}

export const wrapperContext = (root: string) => ({ root, stateDir: STATE_DIR, runtimeDir: RUNTIME_DIR });
export const runtimeAliasDir = () => join(dirname(RUNTIME_DIR), "floka");
