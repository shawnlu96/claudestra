/** SVCRELOAD1 · update after a committed new family reloads only that family (src/lib/floka-services/install/current-reload.ts). */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_PATH } from "../src/lib/paths.ts";
import { maintenanceRoot } from "../src/lib/state-maintenance/paths.ts";
import { createServicePlan } from "../src/lib/floka-services/plan/index.ts";
import { serviceMaintenance, servicesBinding } from "../src/lib/floka-services/install/maintenance.ts";
import { renameInstallGate, withRenameInstallGate } from "../src/lib/floka-services/install/install-gate.ts";
import { readCurrentProof, reloadCurrentFamily, type ReloadPorts, type ServiceManager } from "../src/lib/floka-services/install/current-reload.ts";
import { durableJson, readStored, ServiceStore } from "../src/lib/floka-services/install/store.ts";
import { issueGrant } from "../src/lib/state-maintenance/grant.ts";
import { RECOVERY_KEYS, recoveryPolicy, type ObservedAction, type RecoveryMode } from "../src/lib/recovery-policy.ts";
import type { Controller, Journal, Lease, Service, ServicePlan, Side, State } from "../src/lib/floka-services/plan/types.ts";

const dirs: string[] = [];
afterEach(() => { for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); });

/** Same contract as LaunchdController for what the proof reads: commit leaves committed.json beside the journal. */
class Fake implements Controller {
  journal: Journal | null = null;
  states = new Map<string, State>();
  constructor(p: ServicePlan, readonly root: string) {
    for (const d of p.services) {
      this.states.set(`old:${d.name}`, { loaded: true, pids: [100] });
      this.states.set(`new:${d.name}`, { loaded: false, pids: [] });
    }
  }
  async withLock<T>(_key: string, f: (l: Lease) => Promise<T>) { return f({ assertHeld() {} }); }
  async readJournal() { return this.journal; }
  async saveJournal(j: Journal) { this.journal = structuredClone(j); }
  async auditLegacy(p: ServicePlan) { return Object.fromEntries(p.legacyLabels.map(l => [l, { loaded: false, pids: [], restartDisabled: true }])); }
  async inspect(_p: ServicePlan, d: Service, side: Side) { return this.states.get(`${side}:${d.name}`)!; }
  async prepare() {}
  async unload(_p: ServicePlan, d: Service, side: Side) { this.states.set(`${side}:${d.name}`, { loaded: false, pids: [] }); }
  async waitExited() { return true; }
  async restoreOld() {}
  async load(_p: ServicePlan, d: Service, side: Side) { this.states.set(`${side}:${d.name}`, { loaded: true, pids: [200] }); }
  async health() { return true; }
  async commit(p: ServicePlan, side: Side) { durableJson(join(this.root, "services", "committed.json"), { id: p.id, side }); }
}

/** Records every manager call; `loaded` maps label → state (missing = not loaded). */
class FakeManager implements ServiceManager {
  calls: string[] = [];
  loadedMap = new Map<string, boolean | null>();
  fail = new Set<string>();
  async loaded(label: string) { this.calls.push(`loaded:${label}`); return this.loadedMap.has(label) ? this.loadedMap.get(label)! : false; }
  async reload(label: string): Promise<string | null> { this.calls.push(`reload:${label}`); return this.fail.has(label) ? "kickstart 失败" : null; }
  reloads() { return this.calls.filter(c => c.startsWith("reload:")); }
}

/** Real switch through serviceMaintenance (fake controller) so the proof files are what production writes. */
async function committed(root = join(mkdtempSync(join(tmpdir(), "svc reload ")), "maint"), action?: "rollback") {
  dirs.push(dirname(root));
  const home = dirname(root);
  const input = { home, repoRoot: join(home, "repo"), bunPath: process.execPath, envPath: "/bin", logDir: join(home, "logs") };
  const plan = createServicePlan("services-1", input), controller = new Fake(plan, root);
  const config = { rename: { services: "on", cli: "on" } };
  const base = { root, input, plan, controller, cliPaths: [join(home, "bin", "floka")], config,
    callerSafe: async () => true, provePaths: async () => true, roleRefusal: () => null as string | null };
  const grant = (a = "resume") => issueGrant(root, { action: "services", actor: "owner", binding: servicesBinding(plan, a) });
  expect((await serviceMaintenance({ ...base, grant: grant() })).status).toBe("committed");
  if (action) expect((await serviceMaintenance({ ...base, action, grant: grant(action) })).status).toBe("rolled-back");
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const manager = new FakeManager();
  for (const s of plan.services) manager.loadedMap.set(s.newLabel, true);
  return { root, home, plan, configPath, manager, grant, base };
}

function ports(f: { root: string; configPath: string; manager: FakeManager }, o: { mode?: () => RecoveryMode; lock?: ReloadPorts["lock"] } = {}) {
  const observed: ObservedAction[] = [], locks: string[] = [];
  const p: ReloadPorts = {
    configPath: f.configPath, root: f.root,
    mode: o.mode ?? (() => "on"),
    lock: o.lock ?? (() => { locks.push("take"); return { release: () => locks.push("release") }; }),
    manager: () => f.manager,
    observe: a => observed.push(a),
    version: () => "2.33.0",
  };
  return { p, observed, locks };
}
const gateOf = (f: { configPath: string; root: string }) => renameInstallGate(f.configPath, f.root)!;

test("[验收线 1] committed new family + cli on: update reloads exactly the current family, again without old jobs or new ones", async () => {
  const f = await committed(), { p, locks } = ports(f);
  const gate = gateOf(f);
  expect(gate.errors[0]).toContain("install-cli/update 未执行安装或重载");
  const first = await reloadCurrentFamily(gate, p);
  expect(first.errors).toEqual([]);
  expect(first.daemons.map(d => [d.label, d.loaded])).toEqual(f.plan.services.map(s => [s.newLabel, true]));
  expect(first.daemons[0]!.plistPath).toBe(join(f.home, "Library/LaunchAgents", `${f.plan.services[0]!.newLabel}.plist`));
  const second = await reloadCurrentFamily(gateOf(f), p);
  expect(second).toEqual(first);
  expect(f.manager.reloads()).toEqual([...f.plan.services, ...f.plan.services].map(s => `reload:${s.newLabel}`));
  // Old labels are only ever inspected, never reloaded or started.
  for (const s of f.plan.services) expect(f.manager.calls.filter(c => c.endsWith(s.oldLabel))).toEqual([`loaded:${s.oldLabel}`, `loaded:${s.oldLabel}`]);
  expect(locks).toEqual(["take", "release", "take", "release"]);
  // Nothing new under the maintenance root: no journal change, no new transaction.
  expect(new ServiceStore(f.root).journal()?.status).toBe("committed");
});

test("[验收线 1] a new-family job that is not loaded is reported, never bootstrapped", async () => {
  const f = await committed(), { p } = ports(f);
  const missing = f.plan.services[1]!;
  f.manager.loadedMap.set(missing.newLabel, false);
  const r = await reloadCurrentFamily(gateOf(f), p);
  expect(f.manager.reloads()).not.toContain(`reload:${missing.newLabel}`);
  expect(f.manager.reloads().length).toBe(f.plan.services.length - 1);
  expect(r.daemons.find(d => d.label === missing.newLabel)).toMatchObject({ loaded: false });
  expect(r.errors.join("\n")).toContain(`${missing.newLabel} 未加载，未启动`);
});

test("[验收线 1] the production gate wrapper calls the reloader with its maintenance root", async () => {
  const root = maintenanceRoot(), saved = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : null;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const f = await committed(root);
  dirs.pop(); // the test maintenance home is shared; only its root is cleaned below
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ rename: { services: "on", cli: "on" } }));
  try {
    let installed = false;
    const r = await withRenameInstallGate(async () => { installed = true; return gateOf(f); },
      r => ports({ root: r, configPath: CONFIG_PATH, manager: f.manager }).p);
    expect(installed).toBe(false);
    expect(r.errors).toEqual([]);
    expect(f.manager.reloads()).toEqual(f.plan.services.map(s => `reload:${s.newLabel}`));
  } finally {
    if (saved === null) rmSync(CONFIG_PATH, { force: true }); else writeFileSync(CONFIG_PATH, saved);
    rmSync(root, { recursive: true, force: true });
  }
});

test("[验收线 2] active transaction not settled refuses with no service call", async () => {
  const f = await committed(), { p } = ports(f), store = new ServiceStore(f.root);
  store.save({ ...store.journal()!, status: "running" });
  const gate = gateOf(f), r = await reloadCurrentFamily(gate, p);
  expect(r.errors[0]).toContain("active 未结清");
  expect(r.errors.slice(1)).toEqual(gate.errors);
  expect(r.daemons).toEqual([]);
  expect(f.manager.calls).toEqual([]);
});

test("[验收线 2] lock conflict refuses and is retryable", async () => {
  const f = await committed(), { p } = ports(f, { lock: () => ({ error: "另一个维护执行器(pid 1)正在运行" }) });
  const r = await reloadCurrentFamily(gateOf(f), p);
  expect(r.errors[0]).toContain("稍后重试 install-cli/update");
  expect(f.manager.calls).toEqual([]);
  // Once the lock is free the same update succeeds.
  expect((await reloadCurrentFamily(gateOf(f), ports(f).p)).errors).toEqual([]);
});

test("[验收线 2] bad checksums, missing or conflicting proof refuse with no service call", async () => {
  const cases: [string, (f: Awaited<ReturnType<typeof committed>>) => void, string][] = [
    ["journal checksum", f => writeFileSync(join(f.root, "services/journal.json"), readFileSync(join(f.root, "services/journal.json"), "utf8").replace("committed", "commitxed")), "checksum"],
    ["current checksum", f => writeFileSync(join(f.root, "services-current.json"), JSON.stringify({ value: { side: "new" }, checksum: "x" })), "checksum"],
    ["committed missing", f => rmSync(join(f.root, "services/committed.json")), "提交凭据"],
    ["committed other id", f => durableJson(join(f.root, "services/committed.json"), { id: "services-9", side: "new" }), "提交凭据"],
    ["snapshot missing", f => rmSync(join(f.root, "services/active.json")), "缺少服务快照"],
    ["cli-only snapshot", f => { const s = new ServiceStore(f.root); s.prepare({ ...s.active()!, cliOnly: true }); }, "只切了 CLI"],
  ];
  for (const [name, breakIt, why] of cases) {
    // The gate itself throws on a bad active/current checksum (unchanged); take its result before breaking the proof.
    const f = await committed(), { p } = ports(f), gate = gateOf(f);
    breakIt(f);
    const r = await reloadCurrentFamily(gate, p);
    expect(`${name}: ${r.errors[0]}`).toContain(why);
    expect(f.manager.calls).toEqual([]);
  }
  // A rollback after the commit leaves current=old: the reloader is not involved (old family keeps the existing contract).
  const rolled = await committed(undefined, "rollback");
  expect(readStored<{ side: string }>(join(rolled.root, "services-current.json"))?.side).toBe("old");
  const gate = gateOf(rolled);
  expect(await reloadCurrentFamily(gate, ports(rolled).p)).toBe(gate);
  expect(rolled.manager.calls).toEqual([]);
});

test("[验收线 2] a loaded or unknown old-family job is a conflict: nothing is reloaded", async () => {
  for (const state of [true, null]) {
    const f = await committed(), { p } = ports(f);
    f.manager.loadedMap.set(f.plan.services[0]!.oldLabel, state);
    const r = await reloadCurrentFamily(gateOf(f), p);
    expect(r.errors[0]).toContain("旧族服务仍在或状态未知");
    expect(f.manager.reloads()).toEqual([]);
  }
});

test("[验收线 2] partial reload failure returns per-service results, claims no success and stays retryable", async () => {
  const f = await committed(), { p } = ports(f), bad = f.plan.services[0]!;
  f.manager.fail.add(bad.newLabel);
  const r = await reloadCurrentFamily(gateOf(f), p);
  expect(f.manager.reloads()).toEqual(f.plan.services.map(s => `reload:${s.newLabel}`));
  expect(r.daemons.find(d => d.label === bad.newLabel)).toMatchObject({ loaded: false, warning: "kickstart 失败" });
  expect(r.daemons.filter(d => d.loaded).length).toBe(f.plan.services.length - 1);
  expect(r.errors).toEqual([`${bad.newLabel} 重载失败：kickstart 失败`, "当前族重载未全部成功；可重试 install-cli/update"]);
  f.manager.fail.clear();
  expect((await reloadCurrentFamily(gateOf(f), p)).errors).toEqual([]);
});

test("[验收线 2] observe only records one deduplicated sample and returns the gate result unchanged", async () => {
  const f = await committed(), { p, observed, locks } = ports(f, { mode: () => "observe" });
  const gate = gateOf(f);
  expect(await reloadCurrentFamily(gate, p)).toBe(gate);
  expect(f.manager.calls).toEqual([]);
  expect(locks).toEqual([]);
  expect(observed).toEqual([{ project: "claude-orchestrator", mechanism: "serviceCurrentReload", target: "services-1",
    actionKey: "reload:2.33.0:act", action: expect.stringContaining(`重载当前族 ${f.plan.services.length} 个服务`),
    data: { services: f.plan.services.length } }]);
  // No body or sensitive values: only labels and counts.
  expect(JSON.stringify(observed)).not.toContain(f.home);
});

test("[验收线 2] old family and other upstream gate states are left to the existing contract", async () => {
  const f = await committed(), { p } = ports(f);
  for (const [services, cli] of [["on", "observe"], ["observe", "on"], ["on", "off"], ["off", "off"]]) {
    writeFileSync(f.configPath, JSON.stringify({ rename: { services, cli } }));
    const gate = gateOf(f);
    expect(await reloadCurrentFamily(gate, p)).toBe(gate);
  }
  // services off with cli on after the commit still reloads the committed family (no switch is started).
  writeFileSync(f.configPath, JSON.stringify({ rename: { services: "off", cli: "on" } }));
  expect((await reloadCurrentFamily(gateOf(f), p)).errors).toEqual([]);
  // No current file at all (never switched): unchanged gate result.
  rmSync(join(f.root, "services-current.json"));
  const gate = gateOf(f);
  expect(await reloadCurrentFamily(gate, p)).toBe(gate);
  expect(f.manager.reloads().length).toBe(f.plan.services.length);
});

test("[验收线 2] retired committed family still proves; two retired candidates conflict", async () => {
  const f = await committed(), { p } = ports(f);
  expect((await serviceMaintenance({ ...f.base, action: "retire", grant: f.grant("retire") })).status).toBe("retired");
  expect(readCurrentProof(f.root)).toMatchObject({ ok: true, plan: { id: "services-1" } });
  expect((await reloadCurrentFamily(gateOf(f), p)).errors).toEqual([]);
  renameSync(join(f.root, "retired-services-1"), join(f.root, "retired-services-0"));
  const copy = join(f.root, "retired-services-1");
  mkdirSync(copy);
  for (const n of ["active.json", "journal.json", "committed.json"]) writeFileSync(join(copy, n), readFileSync(join(f.root, "retired-services-0", n)));
  expect(readCurrentProof(f.root)).toMatchObject({ ok: false, error: expect.stringContaining("多个已退役") });
});

test("[验收线 3] on / observe / off, switching while running, and off equals the baseline", async () => {
  let mode: RecoveryMode = "off";
  const f = await committed(), { p, observed } = ports(f, { mode: () => mode });
  const gate = gateOf(f);
  expect(await reloadCurrentFamily(gate, p)).toBe(gate);
  expect(f.manager.calls).toEqual([]);
  mode = "observe";
  expect(await reloadCurrentFamily(gate, p)).toBe(gate);
  expect(observed.length).toBe(1);
  mode = "on";
  expect((await reloadCurrentFamily(gate, p)).errors).toEqual([]);
  expect(f.manager.reloads().length).toBe(f.plan.services.length);
  // Switched to off between the first read and the read under the lock: no action.
  let reads = 0;
  const flip = ports(f, { mode: () => (reads++ === 0 ? "on" : "off") });
  expect(await reloadCurrentFamily(gate, flip.p)).toBe(gate);
  expect(f.manager.reloads().length).toBe(f.plan.services.length);
  // The default for a project with nothing configured is on; the key is registered.
  expect(RECOVERY_KEYS).toContain("serviceCurrentReload");
  const policy = join(f.home, "recovery-policy.json");
  expect(recoveryPolicy("claude-orchestrator", "serviceCurrentReload", policy).mode).toBe("on");
  writeFileSync(policy, JSON.stringify({ version: 1, projects: { "claude-orchestrator": { keys: { serviceCurrentReload: "off" } } } }));
  expect(recoveryPolicy("claude-orchestrator", "serviceCurrentReload", policy).mode).toBe("off");
});

test("[验收线 3] proof changed while waiting for the lock refuses before any service call", async () => {
  const f = await committed();
  const { p } = ports(f, { lock: () => { durableJson(join(f.root, "services/committed.json"), { id: "services-1", side: "new", at: 1 }); return { release() {} }; } });
  const r = await reloadCurrentFamily(gateOf(f), p);
  expect(r.errors[0]).toContain("取锁期间提交证明已变化");
  expect(f.manager.calls).toEqual([]);
});

test("[验收线 3] switching during the loaded-state inventory stops before any reload", async () => {
  for (const to of ["off", "observe", "cli-off", "services-observe"] as const) {
    let mode: RecoveryMode = "on";
    const f = await committed(), { p, observed } = ports(f, { mode: () => mode });
    const loaded = f.manager.loaded.bind(f.manager);
    f.manager.loaded = async label => {
      if (to === "off" || to === "observe") mode = to;
      else writeFileSync(f.configPath, JSON.stringify({ rename: to === "cli-off" ? { services: "on", cli: "off" } : { services: "observe", cli: "on" } }));
      return loaded(label);
    };
    const gate = gateOf(f);
    expect(await reloadCurrentFamily(gate, p)).toBe(gate);
    expect(f.manager.reloads()).toEqual([]);
    expect(observed.length).toBe(to === "observe" ? 1 : 0);
  }
});

test("[验收线 3] switching after the first reload stops the rest and reports the truthful partial result", async () => {
  for (const to of ["off", "observe", "cli-off"] as const) {
    let mode: RecoveryMode = "on";
    const f = await committed(), { p, observed } = ports(f, { mode: () => mode });
    const reload = f.manager.reload.bind(f.manager);
    f.manager.reload = async label => {
      const r = await reload(label);
      if (to === "cli-off") writeFileSync(f.configPath, JSON.stringify({ rename: { services: "on", cli: "off" } }));
      else mode = to;
      return r;
    };
    const [first, ...rest] = f.plan.services;
    const r = await reloadCurrentFamily(gateOf(f), p);
    expect(f.manager.reloads()).toEqual([`reload:${first!.newLabel}`]);
    expect(r.daemons.map(d => [d.label, d.loaded])).toEqual([[first!.newLabel, true], ...rest.map(s => [s.newLabel, false])]);
    expect(r.errors.at(-1)).toContain(`当前族重载中途停止`);
    expect(r.errors.at(-1)).toContain(`已重载 1/${f.plan.services.length} 个`);
    expect(r.warnings).toEqual([`当前族（new）只重载 1/${f.plan.services.length} 个已有服务；未重装 CLI/plist、未迁移`]);
    expect(observed.length).toBe(to === "observe" ? 1 : 0);
  }
});

test("[验收线 2][验收线 3] a failed or thrown first reload followed by a switch keeps the attempted result", async () => {
  for (const how of ["returned", "thrown"] as const) {
    for (const to of ["off", "observe", "cli-off"] as const) {
      let mode: RecoveryMode = "on";
      const f = await committed(), { p, observed } = ports(f, { mode: () => mode });
      f.manager.reload = async label => {
        f.manager.calls.push(`reload:${label}`);
        if (to === "cli-off") writeFileSync(f.configPath, JSON.stringify({ rename: { services: "on", cli: "off" } }));
        else mode = to;
        if (how === "thrown") throw new Error("kickstart timeout");
        return "kickstart timeout";
      };
      const [first, ...rest] = f.plan.services;
      const gate = gateOf(f);
      const r = await reloadCurrentFamily(gate, p);
      expect(r).not.toBe(gate);
      expect(f.manager.reloads()).toEqual([`reload:${first!.newLabel}`]);
      expect(r.daemons.map(d => [d.label, d.loaded])).toEqual([[first!.newLabel, false], ...rest.map(s => [s.newLabel, false])]);
      expect(r.daemons[0]).toMatchObject({ warning: "kickstart timeout" });
      expect(r.errors[0]).toBe(`${first!.newLabel} 重载失败：kickstart timeout`);
      expect(r.errors.at(-1)).toContain(`已重载 0/${f.plan.services.length} 个（尝试 1 个）`);
      expect(r.errors.join("\n")).not.toContain("未执行安装或重载");
      expect(r.warnings).toEqual([`当前族（new）只重载 0/${f.plan.services.length} 个已有服务；未重装 CLI/plist、未迁移`]);
      expect(observed.length).toBe(to === "observe" ? 1 : 0);
    }
  }
});
