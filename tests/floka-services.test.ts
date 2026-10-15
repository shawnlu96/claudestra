import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, cpSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServicePlan } from "../src/lib/floka-services/plan/index.ts";
import { serviceMaintenance, servicesBinding } from "../src/lib/floka-services/install/maintenance.ts";
import { serviceWrapperScript } from "../src/lib/floka-services/install/cli.ts";
import { issueGrant, consumeGrant } from "../src/lib/state-maintenance/grant.ts";
import { runServicePlan } from "../src/lib/floka-services/plan/index.ts";
import { renameInstallGate } from "../src/lib/floka-services/install/install-gate.ts";
import { LaunchdController } from "../src/lib/floka-services/install/host.ts";
import { handlePartButton, partsEntry } from "../src/lib/floka-services/install/buttons.ts";
import { macFor, panelFor, parseButton } from "../src/bridge/state-maintenance-buttons.ts";
import { durableJson, ServiceStore, readStored } from "../src/lib/floka-services/install/store.ts";
import { testChildEnv } from "./test-env.ts";
import type { Run } from "../src/lib/state-maintenance/probe.ts";
import { basename } from "node:path";
import { maintenanceJobLabel, submitPartJob } from "../src/lib/floka-services/install/job.ts";
import { runRequest } from "../src/lib/floka-services/install/runner.ts";
import type { Request } from "../src/lib/floka-services/install/entry.ts";
import type { runBounded } from "../src/lib/run-bounded.ts";
import { refusePartClick } from "../src/lib/floka-services/install/owner.ts";
import { readPrincipalsStrictSync } from "../src/lib/principals.ts";
import { cliInstallPaths } from "../src/lib/floka-services/install/production.ts";
import { maintenanceRoot, prepareMaintenanceRoot } from "../src/lib/state-maintenance/paths.ts";
import { takeExecutorLock } from "../src/lib/state-maintenance/run-store.ts";
import type { Controller, Journal, Lease, Service, ServicePlan, Side, State } from "../src/lib/floka-services/plan/types.ts";

const homes: string[] = [];
afterEach(() => { for (const p of homes.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "floka services "));
  homes.push(home);
  const input = { home, repoRoot: join(home, "custom repo"), bunPath: process.execPath, envPath: "/bin", logDir: join(home, "logs") };
  const plan = createServicePlan("services-1", input);
  const root = join(home, "maintenance");
  const cliPaths = [join(home, "custom bin", "claudestra"), join(home, ".local/bin/floka")];
  mkdirSync(join(home, "custom bin"), { recursive: true });
  writeFileSync(cliPaths[0]!, "old wrapper");
  const controller = new Fake(plan);
  const opts = { root, input, plan, controller, cliPaths,
    callerSafe: async () => true, provePaths: async () => true, roleRefusal: () => null as string | null };
  const grant = (action = "resume", p = plan) => issueGrant(root, {
    action: "services", actor: "owner", binding: servicesBinding(p, action),
  });
  return { ...opts, grant, opts };
}

class Fake implements Controller {
  journal: Journal | null = null;
  states = new Map<string, State>();
  events: string[] = [];
  healthy = true;
  legacyClear = true;
  constructor(p: ServicePlan) {
    for (const d of p.services) {
      this.states.set(`old:${d.name}`, { loaded: true, pids: [100] });
      this.states.set(`new:${d.name}`, { loaded: false, pids: [] });
    }
  }
  async withLock<T>(_key: string, f: (l: Lease) => Promise<T>) { return f({ assertHeld() {} }); }
  async readJournal() { return this.journal; }
  async saveJournal(j: Journal) { this.journal = structuredClone(j); }
  async auditLegacy(p: ServicePlan) {
    return Object.fromEntries(p.legacyLabels.map(l => [l, { loaded: false, pids: [], restartDisabled: this.legacyClear }]));
  }
  async inspect(_p: ServicePlan, d: Service, side: Side) { return this.states.get(`${side}:${d.name}`)!; }
  async prepare(_p: ServicePlan, d: Service) { this.events.push(`prepare:${d.name}`); }
  async unload(_p: ServicePlan, d: Service, side: Side) {
    this.events.push(`unload:${side}:${d.name}`);
    this.states.set(`${side}:${d.name}`, { loaded: false, pids: [] });
  }
  async waitExited() { return true; }
  async restoreOld() { this.events.push("restore"); }
  async load(_p: ServicePlan, d: Service, side: Side) {
    this.events.push(`load:${side}:${d.name}`);
    this.states.set(`${side}:${d.name}`, { loaded: true, pids: [side === "old" ? 100 : 200] });
  }
  async health() { return this.healthy; }
  async commit() { this.events.push("commit"); }
}

test("[验收线 2] off and observe never access installation ports", async () => {
  const f = fixture();
  const controller = new Proxy({} as Controller, { get() { throw new Error("installation accessed"); } });
  for (const mode of [undefined, "off", "invalid", "observe"]) {
    const r = await serviceMaintenance({ ...f.opts, controller, config: { rename: { services: mode } } });
    expect(r.status).toBe(mode === "observe" ? "observed" : "off");
    expect(readFileSync(f.cliPaths[0]!, "utf8")).toBe("old wrapper");
  }
});

test("[验收线 1] four labels and CLI share paths with spaces", () => {
  const f = fixture();
  expect(f.plan.services.map(d => d.newLabel)).toEqual(["bridge", "cron", "scheduler", "launcher"].map(n => `ai.floka.${n}`));
  const script = serviceWrapperScript(f.input.repoRoot, f.input.bunPath, f.plan.services.map(d => d.newLabel));
  expect(Bun.spawnSync(["bash", "-n"], { stdin: Buffer.from(script) }).exitCode).toBe(0);
  expect(script).toContain("ai.floka.bridge");
  expect(script).not.toContain("/bin/launchctl bootstrap");
});

test.each(["job", "wrapper"])("[验收线 1] relocated %s uses real paths with spaces, Unicode and URL delimiters", async kind => {
  const f = fixture(), repo = join(f.input.home, "源码 repo % #");
  const lib = join(repo, "src/lib"), install = join(lib, "floka-services/install");
  cpSync(join(import.meta.dir, "../src/lib"), lib, { recursive: true });
  symlinkSync(join(import.meta.dir, "../node_modules"), join(repo, "node_modules"));
  // Resolve literal imports inside the relocated checkout so the repository's import graph stays complete.
  const code = `
    import { readFileSync } from "node:fs";
    import { submitPartJob } from "./src/lib/floka-services/install/job.ts";
    import { serviceWrapperScript } from "./src/lib/floka-services/install/cli.ts";
    import { WRAPPER_POLICY_PATH } from "./src/lib/floka-services/install/wrapper-policy.ts";
    const f = ${JSON.stringify({ root: f.root, home: f.input.home, bun: f.input.bunPath, labels: f.plan.services.map(s => s.oldLabel) })};
    if (${JSON.stringify(kind)} === "job") {
      await submitPartJob(f.root, "b".repeat(32), async cmd => {
        console.log(JSON.stringify({ plist: readFileSync(cmd[3], "utf8") }));
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      });
    } else {
      console.log(JSON.stringify({ policy: WRAPPER_POLICY_PATH,
        script: serviceWrapperScript(process.cwd(), f.bun, f.labels, {
          root: f.root, stateDir: f.home, runtimeDir: f.home + "/runtime",
        }) }));
    }
  `;
  const child = Bun.spawnSync([process.execPath, "--no-env-file", "--config=/dev/null", "-e", code], {
    cwd: repo, env: testChildEnv({ HOME: f.input.home }),
  });
  expect(child.stderr.toString()).toBe("");
  expect(child.exitCode).toBe(0);
  const relocated = JSON.parse(child.stdout.toString());
  if (kind === "job") {
    const runner = join(install, "runner.ts");
    expect(existsSync(runner)).toBe(true);
    expect(relocated.plist).toContain(`<string>${runner}</string>`);
    expect(relocated.plist).not.toContain("%20");
    return;
  }
  const policy = relocated.policy;
  expect(policy).toBe(join(install, "wrapper-policy.ts"));
  expect(existsSync(policy)).toBe(true);
  writeFileSync(join(f.input.home, "config.json"), JSON.stringify({ rename: { services: "off", cli: "on" } }));
  const fake = join(f.input.home, "fake-launchctl"), log = join(f.input.home, "commands");
  writeFileSync(fake, '#!/bin/bash\nprintf "%s\\n" "$*" >> "$CALL_LOG"\n[[ "$1" == list && "$2" == com.claudestra.* ]]\n');
  chmodSync(fake, 0o755);
  const script = join(f.input.home, "relocated-cli");
  writeFileSync(script, relocated.script.replaceAll("/bin/launchctl", `"${fake}"`));
  const result = Bun.spawnSync(["bash", script], { env: testChildEnv({ HOME: f.input.home, TMUX: "fake", CALL_LOG: log }) });
  expect(result.exitCode).toBe(0);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(
    f.plan.services.map(s => `list ${s.newLabel}`).concat(f.plan.services.map(s => `list ${s.oldLabel}`)));
});

test("[验收线 2] on requires single use grant, caller and path proof", async () => {
  const f = fixture();
  const config = { rename: { services: "on", cli: "on" } };
  expect((await serviceMaintenance({ ...f.opts, config })).status).toBe("blocked");
  const token = f.grant();
  expect((await serviceMaintenance({ ...f.opts, config, grant: token, callerSafe: async () => false })).status).toBe("blocked");
  expect(f.controller.events).toEqual([]);
  const good = f.grant();
  expect((await serviceMaintenance({ ...f.opts, config, grant: good })).status).toBe("committed");
  expect(readFileSync(f.cliPaths[0]!, "utf8")).toBe(readFileSync(f.cliPaths[1]!, "utf8"));
  expect((await serviceMaintenance({ ...f.opts, config, grant: good })).status).toBe("blocked");
});

test("[验收线 3] changed inputs rollback using saved plan and retain current data", async () => {
  const f = fixture();
  const config = { rename: { services: "on", cli: "on" } };
  f.controller.healthy = false;
  expect((await serviceMaintenance({ ...f.opts, config, grant: f.grant() })).status).toBe("blocked");
  const data = join(f.input.home, "current-data");
  writeFileSync(data, "new writes after migration");
  f.controller.healthy = true;
  const plan = createServicePlan(f.plan.id, { ...f.input, bunPath: "/different bun", repoRoot: "/moved repo" });
  expect((await serviceMaintenance({ ...f.opts, config, plan, action: "rollback", grant: f.grant("rollback") })).status).toBe("rolled-back");
  expect(readFileSync(f.cliPaths[0]!, "utf8")).toBe("old wrapper");
  expect(readFileSync(data, "utf8")).toBe("new writes after migration");
});

test("[验收线 2] services/cli modes are independent and either observe forbids effects", async () => {
  for (const [services, cli, status] of [["off", "off", "off"], ["on", "off", "blocked"], ["off", "on", "committed"],
    ["on", "on", "committed"], ["on", "observe", "observed"], ["observe", "on", "observed"]]) {
    const f = fixture(), config = { rename: { services, cli } };
    const r = await serviceMaintenance({ ...f.opts, config, grant: f.grant() });
    expect(String(r.status)).toBe(status!);
    if (services !== "on" || cli !== "on") expect(f.controller.events).toEqual([]);
    if (services === "on" && cli === "off") expect("error" in r && r.error).toContain("先把 cli 切到 on");
    if (services === "off" && cli === "on") {
      const script = readFileSync(f.cliPaths[0]!, "utf8");
      expect(script).toContain('DAEMONS=("com.claudestra.bridge"');
      expect(script).toBe(readFileSync(f.cliPaths[1]!, "utf8"));
    }
  }
});

test("[验收线 1] main PID with descendants commits; a surviving descendant prevents opposite load", async () => {
  const f = fixture();
  for (const d of f.plan.services) f.controller.states.set(`old:${d.name}`, { loaded: true, pids: [100, 101], instances: [100] });
  const original = f.controller.load.bind(f.controller);
  f.controller.load = async (p, d, side) => {
    await original(p, d, side);
    f.controller.states.set(`${side}:${d.name}`, { loaded: true, pids: [200, 201], instances: [200] });
  };
  expect((await runServicePlan({ plan: f.plan, controller: f.controller, rename: { services: "on" } })).status).toBe("committed");
  const g = fixture();
  g.controller.unload = async (_p, d, side) => { g.controller.states.set(`${side}:${d.name}`, { loaded: false, pids: [999], instances: [] }); };
  expect((await runServicePlan({ plan: g.plan, controller: g.controller, rename: { services: "on" } })).status).toBe("blocked");
  expect(g.controller.events.some(e => e.startsWith("load:"))).toBe(false);
});

test("[验收线 3] legacy jobs block installation; input drift resumes from snapshot", async () => {
  const f = fixture(), config = { rename: { services: "on", cli: "on" } };
  f.controller.legacyClear = false;
  expect((await serviceMaintenance({ ...f.opts, config, grant: f.grant() })).status).toBe("blocked");
  expect(f.controller.events).toEqual([]);
  expect(readFileSync(f.cliPaths[0]!, "utf8")).toBe("old wrapper");
  f.controller.legacyClear = true;
  f.controller.healthy = false;
  expect((await serviceMaintenance({ ...f.opts, config, grant: f.grant() })).status).toBe("blocked");
  f.controller.healthy = true;
  const plan = createServicePlan(f.plan.id, { ...f.input, bunPath: "/new bun", repoRoot: "/new repo" });
  const r = await serviceMaintenance({ ...f.opts, config, plan, grant: f.grant() });
  expect(r.status).toBe("committed");
  expect(r.plan).toEqual(f.plan);
  expect(readFileSync(f.cliPaths[0]!, "utf8")).toContain(f.input.repoRoot);
});

test("[验收线 3] rollback restores CLI and permits a fresh switch after terminal retirement", async () => {
  const f = fixture(), config = { rename: { services: "on", cli: "on" } };
  expect((await serviceMaintenance({ ...f.opts, config, grant: f.grant() })).status).toBe("committed");
  expect((await serviceMaintenance({ ...f.opts, config, action: "rollback", grant: f.grant("rollback") })).status).toBe("rolled-back");
  expect(existsSync(f.cliPaths[1]!)).toBe(false);
  const plan = createServicePlan("services-2", f.input);
  expect((await serviceMaintenance({ ...f.opts, config, plan, grant: f.grant("resume", plan) })).status).toBe("blocked");
  expect((await serviceMaintenance({ ...f.opts, config, action: "retire", grant: f.grant("retire") })).status).toBe("retired");
  expect((await serviceMaintenance({ ...f.opts, config, plan, grant: f.grant("resume", plan) })).status).toBe("committed");
});

test("[验收线 2] installer gate off preserves legacy; observe/on cannot run legacy installation", () => {
  const f = fixture(), cfg = join(f.input.home, "config.json");
  expect(renameInstallGate(cfg, f.root)).toBeNull();
  for (const [services, cli] of [["observe", "off"], ["on", "on"], ["off", "on"], ["off", "observe"]]) {
    writeFileSync(cfg, JSON.stringify({ rename: { services, cli } }));
    const r = renameInstallGate(cfg, f.root)!;
    expect(r.daemons).toEqual([]);
    expect(r.cliWrapper).toBe("");
    expect(r.errors.length).toBe(services === "observe" || cli === "observe" ? 0 : 1);
    if (r.errors.length) expect(r.errors[0]).toContain("install-cli/update 未执行安装或重载");
  }
});

test("[验收线 2] legacy install lock conflict reports retry and runs only after maintenance releases ownership", () => {
  const f = fixture(), root = maintenanceRoot(f.input.home);
  prepareMaintenanceRoot(root, []);
  const lock = takeExecutorLock(root);
  if ("error" in lock) throw new Error(lock.error);
  const gate = pathToFileURL(join(import.meta.dir, "../src/lib/floka-services/install/install-gate.ts")).href;
  const code = `
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { withRenameInstallGate } = await import(${JSON.stringify(gate)});
    let called = false;
    const result = await withRenameInstallGate(async () => { called = true; return { errors: [] }; });
    console.log(JSON.stringify({ called, result }));
  `;
  // Exercise the production lock branch with every writable path confined to this temporary HOME.
  const run = () => {
    const child = Bun.spawnSync([process.execPath, "--no-env-file", "--config=/dev/null", "-e", code], {
      env: testChildEnv({ HOME: f.input.home, NODE_ENV: "production", CLAUDESTRA_TEST: "0", FLOKA_TEST: "0",
        CLAUDESTRA_STATE_DIR: join(f.input.home, "state"), CLAUDESTRA_RUNTIME_DIR: join(f.input.home, "runtime") }),
    });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
    return JSON.parse(child.stdout.toString());
  };
  try {
    const blocked = run();
    expect(blocked.called).toBe(false);
    expect(blocked.result.errors[0]).toContain("稍后重试 install-cli/update");
  } finally { lock.release(); }
  expect(run()).toEqual({ called: true, result: { errors: [] } });
});

test("[验收线 1] migrated old CLI attach only inspects the new labels and never starts a second set", async () => {
  const f = fixture(), config = { rename: { services: "on", cli: "on" } };
  writeFileSync(join(f.input.home, "config.json"), JSON.stringify(config));
  const wrapperContext = { root: f.root, stateDir: f.input.home, runtimeDir: join(f.input.home, "runtime") };
  expect((await serviceMaintenance({ ...f.opts, config, wrapperContext, grant: f.grant() })).status).toBe("committed");
  const fake = join(f.input.home, "fake-launchctl"), log = join(f.input.home, "commands");
  writeFileSync(fake, '#!/bin/bash\nprintf "%s\\n" "$*" >> "$CALL_LOG"\n[[ "$1" == list && "$2" == ai.floka.* ]]\n');
  chmodSync(fake, 0o755);
  const script = join(f.input.home, "old-cli");
  writeFileSync(script, readFileSync(f.cliPaths[0]!, "utf8").replaceAll("/bin/launchctl", `"${fake}"`));
  const result = Bun.spawnSync(["bash", script], { env: testChildEnv({ HOME: f.input.home, TMUX: "fake", CALL_LOG: log }) });
  expect(result.exitCode).toBe(0);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(
    f.plan.services.map(d => `list ${d.oldLabel}`).concat(f.plan.services.map(d => `list ${d.newLabel}`)));
});

test("[验收线 2] buttons reject non-owner, forged/channel-bound/expired MACs; grants bind action and transaction once", async () => {
  const f = fixture(), key = Buffer.from("bridge-only-key"), now = Date.now();
  const mac = (a: string, b: string) => macFor(key, "owner-channel", a, b);
  const ctx = { home: f.input.home, maintRoot: f.root, oldRoot: join(f.input.home, "old"), newRoot: join(f.input.home, "new") };
  const view = { config: { rename: { services: "on", cli: "on" } }, plan: () => f.plan, active: () => null };
  const calls: string[][] = [];
  const manager = async (...args: string[]) => { calls.push(args); return { ok: true }; };
  const entry = partsEntry(mac, now).buttons[0]!.id;
  expect((await handlePartButton(entry, manager, ctx, mac, false, view, now)).text).toContain("只有 owner");
  expect((await handlePartButton(entry.slice(0, -1) + "z", manager, ctx, mac, true, view, now)).text).toContain("格式不对");
  expect((await handlePartButton(entry, manager, ctx, mac, true, view, now + 300_001)).text).toContain("过期");
  const other = (a: string, b: string) => macFor(key, "other-channel", a, b);
  expect((await handlePartButton(entry, manager, ctx, other, true, view, now)).text).toContain("频道不符");
  expect(calls).toEqual([]);
  const panel = await handlePartButton(entry, manager, ctx, mac, true, view, now);
  const ask = panel.components![0]!.buttons[0]!;
  const confirm = await handlePartButton(ask.id, manager, ctx, mac, true, view, now);
  await handlePartButton(confirm.components![0]!.buttons[0]!.id, manager, ctx, mac, true, view, now);
  expect(calls).toHaveLength(1);
  const token = calls[0]!.at(-1)!;
  expect(consumeGrant(f.root, token, "services", servicesBinding(f.plan), now).ok).toBe(true);
  expect(consumeGrant(f.root, token, "services", servicesBinding(f.plan), now).ok).toBe(false);
  const wrongAction = issueGrant(f.root, { action: "services", actor: "owner", binding: servicesBinding(f.plan) }, now);
  expect(consumeGrant(f.root, wrongAction, "runtime", { txId: f.plan.id }, now).ok).toBe(false);
  const wrongTx = issueGrant(f.root, { action: "services", actor: "owner", binding: servicesBinding(f.plan) }, now);
  expect(consumeGrant(f.root, wrongTx, "services", { txId: "another" }, now).ok).toBe(false);
  const stateId = `smaint:observe::${macFor(key, "owner-channel", "observe", "")}`;
  expect(parseButton(stateId, "owner-channel", key)).toEqual({ action: "observe", arg: "" });
  const state = panelFor({ mode: "off", problems: [], runs: [], pendingNotes: 0, latestReport: null, barrier: null } as never, "owner-channel", key);
  expect(state.text).toBe("**🧰 状态根维护** 档位 `off`\n还没有预演报告");
});

class Machine {
  loaded = new Map<string, number>();
  children = new Map<number, number>();
  disabled = new Set<string>();
  commands: string[][] = [];
  constructor(readonly plan: ServicePlan) {
    for (const [i, s] of plan.services.entries()) {
      this.loaded.set(s.oldLabel, 1000 + i);
      this.children.set(1000 + i, 2000 + i);
    }
  }
  run: Run = async cmd => {
    this.commands.push(cmd);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (cmd[0] === "ps") return ok([`${process.pid} 1 controller`, ...[...this.loaded.values()].flatMap(pid =>
      [`${pid} 1 job-${pid}`, `${this.children.get(pid)} ${pid} child-${pid}`])].join("\n"));
    if (cmd[0] !== "launchctl") throw new Error(`Unexpected machine command: ${cmd.join(" ")}`);
    if (cmd[1] === "print-disabled") return ok([...this.disabled].map(l => `"${l}" => true`).join("\n"));
    const label = cmd[2]!.split("/").at(-1)!;
    if (cmd[1] === "print") return this.loaded.has(label) ? ok(`pid = ${this.loaded.get(label)}`)
      : { code: 113, stdout: "", stderr: "Could not find service" };
    if (cmd[1] === "disable") { this.disabled.add(label); return ok(); }
    if (cmd[1] === "enable") { this.disabled.delete(label); return ok(); }
    if (cmd[1] === "bootout") { this.loaded.delete(label); return ok(); }
    if (cmd[1] === "bootstrap") {
      const target = basename(cmd[3]!, ".plist"), xml = readFileSync(cmd[3]!, "utf8");
      if (!xml.includes(`<string>${target}</string>`)) throw new Error("Wrong staged label");
      const s = this.plan.services.findIndex(s => s.oldLabel === target || s.newLabel === target);
      expect(s).toBeGreaterThanOrEqual(0);
      const opposite = target.startsWith("ai.") ? this.plan.services[s]!.oldLabel : this.plan.services[s]!.newLabel;
      expect(this.loaded.has(opposite)).toBe(false);
      const pid = (target.startsWith("ai.") ? 3000 : 1000) + s;
      this.loaded.set(target, pid);
      this.children.set(pid, pid + 1000);
      return ok();
    }
    throw new Error(`Unexpected launchctl action: ${cmd[1]}`);
  };
}

test("[验收线 1] real adapter prepares four plists without load and counts main jobs separately from children", async () => {
  const f = fixture(), machine = new Machine(f.plan);
  let proofs = 0;
  const host = new LaunchdController({ root: f.root, home: f.input.home, uid: 501, run: machine.run,
    beforeFirstLoad: async () => { proofs++; } });
  const agents = join(f.input.home, "Library/LaunchAgents");
  mkdirSync(agents, { recursive: true });
  for (const s of f.plan.services) writeFileSync(join(agents, `${s.oldLabel}.plist`), `<string>${s.oldLabel}</string>`);
  await host.withLock("floka-services", async () => {
    for (const s of f.plan.services) await host.prepare(f.plan, s);
    expect(machine.commands).toEqual([]);
    for (const s of f.plan.services) expect(existsSync(join(agents, `${s.newLabel}.plist`))).toBe(false);
  });
  const r = await serviceMaintenance({ ...f.opts, controller: host, config: { rename: { services: "on", cli: "on" } }, grant: f.grant() });
  expect(r.status).toBe("committed");
  expect(proofs).toBe(1);
  expect([...machine.loaded.keys()]).toEqual(f.plan.services.map(s => s.newLabel));
  const state = await host.inspect(f.plan, f.plan.services[0]!, "new");
  expect(state.instances).toHaveLength(1);
  expect(state.pids).toHaveLength(2);
  const rollback = await serviceMaintenance({ ...f.opts, controller: host, config: { rename: { services: "on", cli: "on" } },
    action: "rollback", grant: f.grant("rollback") });
  expect(rollback.status).toBe("rolled-back");
  for (const s of f.plan.services) expect(readFileSync(join(agents, `${s.oldLabel}.plist`), "utf8")).toBe(`<string>${s.oldLabel}</string>`);
});

test("[验收线 2] persistent journal corruption and identity drift refuse before service effects", async () => {
  const f = fixture(), config = { rename: { services: "on", cli: "on" } };
  f.controller.healthy = false;
  expect((await serviceMaintenance({ ...f.opts, config, grant: f.grant(), provePaths: async () => "identity-1" })).status).toBe("blocked");
  const calls = f.controller.events.length;
  expect((await serviceMaintenance({ ...f.opts, config, grant: f.grant(), provePaths: async () => "identity-2" })).status).toBe("blocked");
  expect(f.controller.events).toHaveLength(calls);
  const store = new ServiceStore(f.root);
  writeFileSync(store.journalPath(), JSON.stringify({ value: { version: 1 }, checksum: "wrong" }));
  expect((await serviceMaintenance({ ...f.opts, config, grant: f.grant(), provePaths: async () => "identity-1" })).status).toBe("blocked");
  expect(f.controller.events).toHaveLength(calls);
  expect(() => readStored(store.journalPath())).toThrow("checksum");
});

function jobFixture() {
  const f = fixture(), id = "a".repeat(32), label = maintenanceJobLabel(id);
  const jobs = new Set(["com.claudestra.bridge"]), calls: string[][] = [];
  const request: Request = { version: 1, item: "services", txId: f.plan.id, action: "resume", input: f.input, cliPaths: f.cliPaths,
    config: { rename: { services: "on", cli: "on" } }, authorization: { action: "services", actor: "owner",
      binding: servicesBinding(f.plan), issuedAt: Date.now(), expiresAt: Date.now() + 300_000 } };
  durableJson(join(f.root, "part-requests", `${id}.json`), request);
  const command: typeof runBounded = async cmd => {
    calls.push(cmd);
    if (cmd[1] === "bootstrap") {
      const plist = readFileSync(cmd[3]!, "utf8");
      expect(plist).toContain(`<key>Label</key><string>${label}</string>`);
      expect(plist).toContain("<key>KeepAlive</key><false/>");
      jobs.add(label);
    }
    if (cmd[1] === "bootout") jobs.delete(cmd[2]!.split("/").at(-1)!);
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  return { ...f, id, label, jobs, calls, command };
}

test("[验收线 2] one-shot XPC identity, responsibility isolation, at-most-once submission and cleanup", async () => {
  const f = jobFixture();
  await submitPartJob(f.root, f.id, f.command);
  let effects = 0;
  const execute = async () => {
    effects++;
    // Reaping bridge's responsibility chain leaves the separate launchd job alive.
    await f.command(["/bin/launchctl", "bootout", "gui/501/com.claudestra.bridge"], { timeoutMs: 1000 });
    expect(f.jobs.has(f.label)).toBe(true);
    return { status: "committed" };
  };
  expect(await runRequest(f.root, f.id, { xpc: "com.claudestra.bridge", command: f.command, execute })).toMatchObject({ status: "blocked" });
  expect(effects).toBe(0);
  expect(f.jobs.has(f.label)).toBe(true);
  const bootstraps = f.calls.filter(c => c[1] === "bootstrap").length;
  await expect(submitPartJob(f.root, f.id, f.command)).rejects.toThrow("already submitted");
  expect(f.calls.filter(c => c[1] === "bootstrap")).toHaveLength(bootstraps);
  expect(await runRequest(f.root, f.id, { xpc: f.label, command: f.command, execute })).toEqual({ status: "committed" });
  expect(effects).toBe(1);
  expect(f.jobs.has(f.label)).toBe(false);
  expect(existsSync(join(f.root, "part-jobs", f.id, "job.plist"))).toBe(false);
  expect(readStored<Record<string, unknown>>(join(f.root, "part-requests", `${f.id}.result.json`))).toEqual({ status: "committed" });
  expect(await runRequest(f.root, f.id, { xpc: f.label, command: f.command, execute })).toMatchObject({ status: "blocked" });
  expect(effects).toBe(1);
  expect(readStored<Record<string, unknown>>(join(f.root, "part-requests", `${f.id}.result.json`))).toEqual({ status: "committed" });
});

test("[验收线 3] failed one-shot still retains its result and cleans the temporary job", async () => {
  const f = jobFixture();
  await submitPartJob(f.root, f.id, f.command);
  const result = await runRequest(f.root, f.id, { xpc: f.label, command: f.command, execute: async () => { throw new Error("health failed"); } });
  expect(result).toEqual({ status: "blocked", error: "health failed" });
  expect(f.jobs.has(f.label)).toBe(false);
  expect(readStored<unknown>(join(f.root, "part-requests", `${f.id}.result.json`))).toMatchObject(result as Record<string, unknown>);
});

test("[验收线 2] actual Discord owner gate rejects external and corrupt principals, leaving state buttons unchanged", async () => {
  const replies: string[] = [], uid = "12345678901234567";
  const click = { followUp: async (m: { content: string }) => { replies.push(m.content); } };
  const principals = (role: "owner" | "external") => () => ({ principals: [{ id: `discord:${uid}`, role, agents: ["*"], createdAt: "test" }] });
  expect(await refusePartClick("smaint:parts:run", uid, click, principals("owner"))).toBe(false);
  expect(replies).toEqual([]);
  expect(await refusePartClick("smaint:parts:run", uid, click, principals("external"))).toBe(true);
  expect(replies).toHaveLength(1);
  const f = fixture(), principalsPath = join(f.input.home, "principals.json");
  writeFileSync(principalsPath, "{ private detail");
  expect(await refusePartClick("smaint:parts:run", uid, click, () => readPrincipalsStrictSync(principalsPath))).toBe(true);
  expect(replies[1]).not.toContain("private detail");
  expect(await refusePartClick("smaint:observe:old", uid, click, () => { throw new Error("state must not read new gate"); })).toBe(false);
  expect(replies).toHaveLength(2);
});

test("[验收线 1] existing custom PATH wrapper and explicit installation paths are retained", () => {
  const f = fixture(), path = f.cliPaths[0]!;
  writeFileSync(path, serviceWrapperScript(f.input.repoRoot, f.input.bunPath, f.plan.services.map(s => s.oldLabel)));
  const explicit = join(f.input.home, "another bin", "claudestra");
  const paths = cliInstallPaths(f.input.home, { rename: { cliPaths: [explicit] } }, join(f.input.home, "custom bin"));
  expect(paths).toContain(path);
  expect(paths).toContain(join(f.input.home, "custom bin", "floka"));
  expect(paths).toContain(explicit);
  expect(paths).toContain(join(f.input.home, ".local/bin/floka"));
});
