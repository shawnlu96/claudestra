import { readFileSync } from "node:fs";
import { join } from "node:path";
import { takeExecutorLock } from "../../state-maintenance/run-store.js";
import { ensureDir, maintPaths } from "../../state-maintenance/paths.js";
import { writeTextAtomicSync } from "../../state-file.js";
import type { Run, RunResult } from "../../state-maintenance/probe.js";
import { isTestProcess } from "../../test-guard.js";
import type { Controller, Journal, Lease, Service, ServicePlan, Side, State } from "../plan/types.js";
import { captureCli, restoreCli, type CliBefore } from "./cli.js";
import { durableJson, readStored, ServiceStore } from "./store.js";

interface Process { pid: number; parent: number; identity: string }
export interface HostOptions {
  root: string;
  home: string;
  uid: number;
  run: Run;
  beforeFirstLoad(): Promise<void>;
  health?(s: Service, side: Side): Promise<boolean>;
}

export const realRun: Run = async (cmd, timeoutMs = 30_000): Promise<RunResult> => {
  if (isTestProcess()) throw new Error("Tests must inject a fake service controller");
  const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { stdout, stderr, code: p.signalCode ? null : code };
  } finally { clearTimeout(timer); }
};

/** Main job PIDs count instances; persisted process identities track descendants after bootout/reparenting. */
export class LaunchdController implements Controller {
  private lease: Lease | null = null;
  private checkedLoad = false;
  constructor(readonly o: HostOptions) {}
  private domain() { return `gui/${this.o.uid}`; }
  private path(label: string) { return join(this.o.home, "Library/LaunchAgents", `${label}.plist`); }
  private file(name: string) { return join(this.o.root, "services", name); }
  private async command(args: string[]) {
    this.lease?.assertHeld();
    const r = await this.o.run(args);
    this.lease?.assertHeld();
    if (r.code === null || r.spawnError || /permission denied|operation not permitted/i.test(r.stderr)) throw new Error(`Service command failed: ${args[0]}`);
    return r;
  }
  async withLock<T>(_key: string, fn: (lease: Lease) => Promise<T>): Promise<T> {
    ensureDir(maintPaths(this.o.root).control);
    // Share STATE2's PID-owned executor lock: a suspended, still-live port call never loses its lease.
    const lock = takeExecutorLock(this.o.root);
    if ("error" in lock) throw new Error(lock.error);
    const lease = { assertHeld: () => {
      if (readFileSync(lock.path, "utf8") !== String(process.pid)) throw new Error("Service maintenance lease lost");
    } };
    this.lease = lease;
    this.checkedLoad = false;
    try { return await fn(lease); } finally { this.lease = null; lock.release(); }
  }
  async readJournal() { return new ServiceStore(this.o.root).journal(); }
  async saveJournal(j: Journal) { new ServiceStore(this.o.root).save(j); }
  private async processes(): Promise<Process[]> {
    const r = await this.command(["ps", "-axo", "pid=,ppid=,lstart=,command="]);
    if (r.code !== 0) throw new Error("Cannot inspect service processes");
    const rows = r.stdout.split("\n").filter(s => s.trim()).map(s => /^(\d+)\s+(\d+)\s+(.+)$/.exec(s.trim()));
    if (rows.some(r => !r)) throw new Error("Unknown process listing");
    const processes = rows.map(r => ({ pid: Number(r![1]), parent: Number(r![2]), identity: r![3]! }));
    if (!processes.some(p => p.pid === process.pid)) throw new Error("Process scan cannot see the controller itself");
    return processes;
  }
  private async registration(label: string): Promise<{ loaded: boolean; pid: number | null }> {
    const r = await this.command(["launchctl", "print", `${this.domain()}/${label}`]);
    if (r.code !== 0) {
      if (!/could not find service|service not found/i.test(r.stderr)) throw new Error(`Unknown launchd registration: ${label}`);
      return { loaded: false, pid: null };
    }
    const match = /^\s*pid = (\d+)\s*$/m.exec(r.stdout);
    return { loaded: true, pid: match ? Number(match[1]) : null };
  }
  private async state(label: string): Promise<State> {
    const reg = await this.registration(label), all = await this.processes();
    const trackedPath = this.file(`pids-${label}.json`);
    const previous = readStored<Process[]>(trackedPath) ?? [];
    const ids = new Set(reg.pid ? [reg.pid] : []);
    for (const p of all) if (previous.some(old => old.pid === p.pid && old.identity === p.identity)) ids.add(p.pid);
    let count = -1;
    while (count !== ids.size) {
      count = ids.size;
      for (const p of all) if (ids.has(p.parent)) ids.add(p.pid);
    }
    const found = all.filter(p => ids.has(p.pid));
    if (reg.pid && !found.some(p => p.pid === reg.pid)) throw new Error("Launchd main PID is missing from process scan");
    durableJson(trackedPath, found);
    return { loaded: reg.loaded, pids: found.map(p => p.pid), instances: reg.pid ? [reg.pid] : [] };
  }
  async inspect(_p: ServicePlan, s: Service, side: Side) { return this.state(side === "old" ? s.oldLabel : s.newLabel); }
  async auditLegacy(p: ServicePlan) {
    const disabled = await this.command(["launchctl", "print-disabled", this.domain()]);
    if (disabled.code !== 0) throw new Error("Cannot audit legacy restart sources");
    return Object.fromEntries(await Promise.all(p.legacyLabels.map(async label => {
      const s = await this.state(label);
      const before = captureCli(this.path(label));
      return [label, { ...s, restartDisabled: before.kind === "missing" || disabled.stdout.includes(`"${label}" => true`) }];
    })));
  }
  async prepare(_p: ServicePlan, s: Service) {
    const backup = this.file(`before-${s.name}.json`);
    if (!readStored<CliBefore>(backup)) durableJson(backup, captureCli(this.path(s.oldLabel)));
    if (!s.plist.includes(`<string>${s.newLabel}</string>`)) throw new Error("Staged plist label mismatch");
    writeTextAtomicSync(this.file(`${s.newLabel}.plist`), s.plist, { mode: 0o600, noFollow: true });
  }
  async unload(p: ServicePlan, s: Service, side: Side) {
    const label = side === "old" ? s.oldLabel : s.newLabel;
    await this.inspect(p, s, side);
    const disable = await this.command(["launchctl", "disable", `${this.domain()}/${label}`]);
    if (disable.code !== 0) throw new Error(`Cannot disable ${label}`);
    await this.command(["launchctl", "bootout", `${this.domain()}/${label}`]);
    if ((await this.registration(label)).loaded) throw new Error(`Cannot unload ${label}`);
  }
  async waitExited(p: ServicePlan, s: Service, side: Side) {
    const until = Date.now() + 30_000;
    do {
      const state = await this.inspect(p, s, side);
      if (!state.loaded && state.pids?.length === 0) return true;
      await Bun.sleep(250);
    } while (Date.now() < until);
    return false;
  }
  async restoreOld(_p: ServicePlan, s: Service) {
    const before = readStored<CliBefore>(this.file(`before-${s.name}.json`));
    if (before) restoreCli(before);
  }
  async load(_p: ServicePlan, s: Service, side: Side) {
    if (!this.checkedLoad) { await this.o.beforeFirstLoad(); this.checkedLoad = true; }
    const label = side === "old" ? s.oldLabel : s.newLabel;
    if (side === "new") {
      const staged = readFileSync(this.file(`${label}.plist`), "utf8");
      if (staged !== s.plist || !staged.includes(`<string>${label}</string>`)) throw new Error("Staged plist has changed");
      writeTextAtomicSync(this.path(label), staged, { mode: 0o600, noFollow: true });
    }
    for (const args of [["enable", `${this.domain()}/${label}`], ["bootstrap", this.domain(), this.path(label)]]) {
      const r = await this.command(["launchctl", ...args]);
      if (r.code !== 0) throw new Error(`Cannot load ${label}`);
    }
  }
  async health(p: ServicePlan, s: Service, side: Side) {
    const until = Date.now() + 10_000;
    do {
      const cur = await this.inspect(p, s, side);
      if (cur.loaded && cur.instances?.length === 1 && (!this.o.health || await this.o.health(s, side))) return true;
      await Bun.sleep(250);
    } while (Date.now() < until);
    return false;
  }
  async commit(p: ServicePlan, side: Side) { durableJson(this.file("committed.json"), { id: p.id, side }); }
  async callerSafe(p: ServicePlan, pid = process.pid): Promise<boolean> {
    for (const s of p.services) for (const label of [s.oldLabel, s.newLabel]) {
      const main = (await this.registration(label)).pid;
      if (main === pid) return false;
    }
    return true;
  }
}
