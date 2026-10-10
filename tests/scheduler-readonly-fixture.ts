/** Shared scheduler integration ports: writer prepares, LedgerReader executes, leased manager children commit. */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireLock } from "../src/lib/file-lock.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { interpretManagerRun } from "../src/lib/run-manager.js";
import { runBounded, type BoundedResult } from "../src/lib/run-bounded.js";
import { schedulerAutoTick, type AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { schedulerPass, type PassOpts } from "../src/lib/scheduler-pass.js";
import { isUnderTempDir } from "../src/lib/test-guard.js";
import { autoFixture } from "./scheduler-auto-helpers.js";
import { testChildEnv } from "./test-env.js";

interface ManagerCall extends BoundedResult { args: string[]; result: Record<string, unknown> }

export async function readonlyFixture(opts: { stateDir?: string } = {}) {
  const prepare = autoFixture(), reader = new LedgerReader(join(prepare.dir, "ledger.sqlite"));
  const root = opts.stateDir ?? prepare.dir;
  if (!isUnderTempDir(root)) { prepare.close(); throw new Error("fixture state must be temporary"); }
  mkdirSync(root, { recursive: true });
  const links = root === prepare.dir ? [] : ["ledger.sqlite", "registry.json"];
  for (const name of links) {
    if (existsSync(join(root, name))) { prepare.close(); throw new Error(`fixture state already occupied: ${name}`); }
    symlinkSync(join(prepare.dir, name), join(root, name));
  }
  const home = join(root, "home"), tmp = join(root, "tmp"), runtime = join(root, "runtime");
  for (const dir of [home, tmp, runtime]) mkdirSync(dir);
  const singletonPath = join(root, "scheduler.pid"), maintenancePath = join(root, "maintenance.lock");
  const singleton = await acquireLock(singletonPath, 0);
  if (!singleton) { reader.close(); prepare.close(); throw new Error("fixture singleton unavailable"); }
  const maintenance = { path: maintenancePath, marker: join(root, "update.marker"), request: join(root, "update.request") };
  writeFileSync(join(root, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "test", dirs: [root], createdAt: "2026-01-01" }] }));
  writeFileSync(join(root, "scheduler.json"), JSON.stringify({ enabled: true, autoDispatch: true,
    projects: { p: { maxActiveWorkers: 2, requiredChecks: ["ci"], repoDir: root } } }));
  writeFileSync(join(root, "T1.md"), "# T1\nAcceptance: read only review\n");
  prepare.db.query("UPDATE tasks SET spec=? WHERE id='T1'").run(join(root, "T1.md"));
  const env = testChildEnv({ HOME: home, TMPDIR: tmp, CLAUDESTRA_STATE_DIR: root, CLAUDESTRA_RUNTIME_DIR: runtime,
    CODEX_HOME: join(home, "codex"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    CLAUDESTRA_SCHEDULER_SERVICE: "1" });
  const calls: ManagerCall[] = [], diagnostics: string[] = [];
  let beforeChild: ((args: string[]) => void | Promise<void>) | undefined;
  let childPath = resolve("src/manager.ts");
  let childEnv: Record<string, string | undefined> = {};
  const db = () => {
    const ro = reader.get();
    if (!ro) throw new Error("fixture ledger reader unavailable");
    return ro;
  };
  const manager: AutoTickDeps["manager"] = async (...args) => {
    // Only ledger commands belong on this port. Agent creation, models and host effects need explicit fake ports.
    if (args[0] !== "ledger" || args[1] === "scheduler-review-swap") throw new Error(`unexpected external command: ${args.join(" ")}`);
    const lease = encodeLease({ singleton: { path: singletonPath, token: singleton.token },
      maintenance: { path: maintenancePath, token: readFileSync(join(maintenancePath, "owner"), "utf8") } });
    await beforeChild?.(args);
    const raw = await runBounded([process.execPath, "--no-env-file", childPath, ...args],
      { env: { ...env, CLAUDESTRA_SCHEDULER_LEASE: lease, ...childEnv }, timeoutMs: 20_000 });
    let result = interpretManagerRun({ cmd: args.join(" "), out: raw.stdout, err: raw.stderr, exitCode: raw.code, timedOut: raw.timedOut,
      budgetMs: 20_000 }) as Record<string, unknown>;
    if ((raw.code !== 0 || raw.timedOut) && result.ok === true) result = { ok: false, error: `child exit=${raw.code}, timeout=${raw.timedOut}` };
    calls.push({ args, result, ...raw });
    if (raw.stderr) diagnostics.push(raw.stderr);
    if (result.ok !== true) diagnostics.push(`${args[1]}: ${String(result.error)}`);
    return result;
  };
  const deps: AutoTickDeps = { ...prepare.tickDeps, manager, now: () => Date.now() };
  const active = () => { if (!singleton.held()) throw new SchedulerStopped("fixture lost singleton"); };
  const withMaintenance = async <T>(fn: () => Promise<T>) => {
    active();
    const lock = await acquireLock(maintenancePath, 0);
    if (!lock) throw new Error("fixture maintenance unavailable");
    try { return await fn(); } finally { lock.release(); }
  };
  const tick = () => withMaintenance(() => schedulerAutoTick(db(), { p: { maxActiveWorkers: 2 } }, deps));
  const pass = (over: Partial<PassOpts> = {}, autoDispatch = true) => schedulerPass(db(), parseSchedulerConfig({
    ...JSON.parse(readFileSync(join(root, "scheduler.json"), "utf8")), autoDispatch }), {
    assertOwner: active, singleton: { path: singletonPath, token: singleton.token }, maintenance, manager, autoDeps: () => deps,
    // These unrelated services would create workers or reach external tools; the tested pass / auto / merge still run for real.
    peerPr: async () => ({ failed: [] }), autostart: () => ({ resume: async () => [], start: async () => [] }),
    retire: async () => [], lifecycle: async () => [], lockYield: async () => [], ...over,
  });
  return { prepare, reader, db, root, env, calls, diagnostics, deps, manager, tick, pass, withMaintenance, maintenance, singletonPath,
    beforeChild: (fn: typeof beforeChild) => { beforeChild = fn; },
    childPath: (path: string) => { childPath = path; }, childEnv: (extra: typeof childEnv) => { childEnv = extra; },
    close: () => { reader.close(); singleton.release(); prepare.close(); for (const name of links) rmSync(join(root, name));
      for (const dir of [home, tmp, runtime]) rmSync(dir, { recursive: true, force: true }); } };
}

export type ReadonlyFixture = Awaited<ReturnType<typeof readonlyFixture>>;
