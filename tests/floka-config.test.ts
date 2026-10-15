import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { nodeStateFs } from "../src/lib/floka-migration/state/fs-adapter.ts";
import { migrateState, rollbackState, recoverState } from "../src/lib/floka-migration/state/migrate.ts";
import { testChildEnv } from "./test-env.ts";

const roots: string[] = [];
const pem = String(generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }));
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "floka-config-"));
  roots.push(home);
  const oldRoot = join(home, ".claude-orchestrator"), newRoot = join(home, ".floka");
  const journalDir = join(home, ".claudestra-maintenance/state/journals/run-1");
  mkdirSync(oldRoot);
  writeFileSync(join(oldRoot, "instance-id"), "fixture-instance\n");
  writeFileSync(join(oldRoot, "instance-key.pem"), pem);
  writeFileSync(join(oldRoot, "config.json"), JSON.stringify({ rename: { state: "on" }, autoUpdate: { claudestra: false } }));
  return { home, oldRoot, newRoot, journalDir, txId: "run-1", fs: nodeStateFs, mode: "on", writers: { activeWriters: async () => [] } };
}
function child(home: string, code: string | string[], override?: string) {
  const env = testChildEnv({ HOME: home, TMPDIR: home, CLAUDESTRA_RUNTIME_DIR: join(home, "run"), BRIDGE_PORT: "9" });
  delete env.CLAUDESTRA_STATE_DIR;
  delete env.FLOKA_STATE_DIR;
  if (override) env.CLAUDESTRA_STATE_DIR = override;
  const argv = typeof code === "string" ? ["-e", code] : code;
  return spawnSync(process.execPath, ["--no-env-file", "--config=/dev/null", ...argv], { env, encoding: "utf8", timeout: 20_000, cwd: import.meta.dir + "/.." });
}
function resolved(f: ReturnType<typeof fixture>) {
  const r = child(f.home, 'import {stateDir} from "./src/lib/state-dir.ts"; console.log(stateDir());');
  expect(r.status).toBe(0);
  return r.stdout.trim();
}

test("[验收线 1] default root follows a committed transaction, interruption and rollback preserve identity", async () => {
  const f = fixture();
  mkdirSync(f.newRoot);
  expect(resolved(f)).toBe(f.oldRoot);
  await expect(migrateState({ ...f, crashAt: p => { if (p === "applied:state-alias") throw Error("crash"); } })).rejects.toThrow("crash");
  expect(resolved(f)).toBe(f.oldRoot);
  expect((await migrateState(f)).status).toBe("committed");
  expect(resolved(f)).toBe(f.newRoot);
  writeFileSync(join(f.newRoot, "new-task.json"), '{"task":"after-migration"}');
  expect((await rollbackState({ ...f, txId: "rollback-1" })).status).toBe("committed");
  expect(resolved(f)).toBe(f.oldRoot);
  expect(readFileSync(join(f.oldRoot, "new-task.json"), "utf8")).toContain("after-migration");
});

test("[验收线 1] STATE2 keeps its legacy root after default resolution switches", async () => {
  const f = fixture();
  expect((await migrateState(f)).status).toBe("committed");
  const r = child(f.home, `import {stateDir} from './src/lib/state-dir.ts';
    import {productionContext} from './src/lib/state-maintenance/context.ts';
    console.log(JSON.stringify([stateDir(),productionContext().oldRoot,productionContext().newRoot]));`);
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual([f.newRoot, f.oldRoot, f.newRoot]);
});

test("[验收线 2] new-only auto update is read by old consumers and unrelated writes preserve raw fields", () => {
  const f = fixture();
  const raw = { autoUpdate: { floka: false, vendor: { keep: true } }, extra: { keep: [1, 2] }, rename: { config: "observe" } };
  const path = join(f.oldRoot, "config.json");
  writeFileSync(path, JSON.stringify(raw));
  const r = child(f.home, `import {readConfig,setLang} from './src/lib/config-store.ts';
    console.log((await readConfig()).autoUpdate.claudestra); await setLang('en');`, f.oldRoot);
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("false");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...raw, lang: "en" });
});

test("[验收线 2] conflicting config refuses automatic overwrite", () => {
  const f = fixture();
  const path = join(f.oldRoot, "config.json");
  const raw = JSON.stringify({ autoUpdate: { floka: false, claudestra: true } });
  writeFileSync(path, raw);
  const r = child(f.home, `import {setLang} from './src/lib/config-store.ts'; await setLang('en');`, f.oldRoot);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("autoUpdate");
  expect(readFileSync(path, "utf8")).toBe(raw);
});

test("[验收线 2] conflicting brand values remain readable with legacy precedence and a value-free diagnostic", () => {
  const f = fixture(), path = join(f.oldRoot, "config.json");
  const raw = JSON.stringify({ autoUpdate: { claudestra: false, floka: true }, lang: "en", groqApiKey: "fixture-secret" });
  writeFileSync(path, raw);
  const r = child(f.home, `import {readConfig,readConfigSync} from './src/lib/config-store.ts';
    console.log(JSON.stringify([(await readConfig()).autoUpdate.claudestra, readConfigSync().lang]));`, f.oldRoot);
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual([false, "en"]);
  expect(r.stderr).toContain("autoUpdate.claudestra conflicts with autoUpdate.floka");
  expect(r.stderr).not.toContain("fixture-secret");
  expect(readFileSync(path, "utf8")).toBe(raw);
});

test("[验收线 2] stale writers refuse overwriting newer unrelated settings", () => {
  const f = fixture(), path = join(f.oldRoot, "config.json");
  const r = child(f.home, `import {readConfig,writeConfig,setLang} from './src/lib/config-store.ts';
    const stale=await readConfig(); await setLang('en'); stale.pushAllAsks=true;
    try { await writeConfig(stale); process.exit(3); } catch (e) { console.log(e.message); }`, f.oldRoot);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("config changed since read");
  expect(JSON.parse(readFileSync(path, "utf8")).lang).toBe("en");
  expect(JSON.parse(readFileSync(path, "utf8")).pushAllAsks).toBeUndefined();
});

test("[验收线 3] custom roots remain explicit and require approval to move", async () => {
  const f = fixture();
  expect(child(f.home, 'import {stateDir} from "./src/lib/state-dir.ts"; console.log(stateDir());', f.oldRoot + "-custom").stdout.trim()).toBe(f.oldRoot + "-custom");
  expect((await migrateState({ ...f, newRoot: f.newRoot + "-custom" })).status).toBe("refused");
  expect(existsSync(join(f.oldRoot, "instance-id"))).toBe(true);
});

test("[验收线 1] identity conflicts, orphan new root and corrupt proof never select a new identity", async () => {
  const f = fixture();
  mkdirSync(f.newRoot);
  writeFileSync(join(f.newRoot, "instance-id"), "another-instance");
  writeFileSync(join(f.newRoot, "instance-key.pem"), pem);
  const code = 'import {stateDir} from "./src/lib/state-dir.ts"; console.log(stateDir());';
  expect(child(f.home, code).status).not.toBe(0);
  rmSync(f.newRoot, { recursive: true });
  expect((await migrateState(f)).status).toBe("committed");
  const journal = join(f.journalDir, "run-1.journal.json");
  writeFileSync(journal, readFileSync(journal, "utf8").replace('"committed"', '"running"'));
  expect(resolved(f)).toBe(f.oldRoot);
  rmSync(f.oldRoot);
  expect(child(f.home, code).status).not.toBe(0);
  expect(readFileSync(join(f.newRoot, "instance-id"), "utf8")).toBe("fixture-instance\n");
});

test("[验收线 1] off and observe retain the legacy path after a committed migration", async () => {
  const f = fixture();
  await migrateState(f);
  for (const state of [undefined, "off", "observe", "typo"]) {
    writeFileSync(join(f.newRoot, "config.json"), JSON.stringify({ rename: { state } }));
    expect(resolved(f)).toBe(f.oldRoot);
  }
});

for (const mode of [undefined, "off", "observe", "on"]) {
  for (const au of [{ claudestra: false }, { floka: false }, { claudestra: false, floka: false }]) {
    for (const target of ["claudestra", "floka"]) {
      test(`[验收线 2] config spelling ${Object.keys(au)} / ${mode ?? "default"} / setter ${target}`, () => {
        const f = fixture(), path = join(f.oldRoot, "config.json");
        const raw = { autoUpdate: { ...au, future: 17 }, custom: [1], rename: { config: mode }, fleet: { future: "keep" } };
        writeFileSync(path, JSON.stringify(raw));
        const r = child(f.home, `import {setAutoUpdate} from './src/lib/config-store.ts'; await setAutoUpdate('${target}',true);`, f.oldRoot);
        expect(r.status).toBe(0);
        const after = JSON.parse(readFileSync(path, "utf8"));
        expect(after).toEqual(JSON.parse(JSON.stringify({ ...raw, autoUpdate: { ...raw.autoUpdate,
          ...("claudestra" in au ? { claudestra: true } : {}), ...("floka" in au ? { floka: true } : {}) } })));
      });
    }
  }
}

test("[验收线 2] brand compatibility retains intentional deletion and unknown nested settings", () => {
  const f = fixture(), path = join(f.oldRoot, "config.json");
  writeFileSync(path, JSON.stringify({ groqApiKey: "fixture-key", autoCompact: { future: 12, idleHours: 2 }, autoUpdate: { floka: false } }));
  const r = child(f.home, `import {setGroqApiKey,setAutoCompact,setPushAllAsks} from './src/lib/config-store.ts';
    await setGroqApiKey(''); await setAutoCompact({idleHours:3}); await setPushAllAsks(true);`, f.oldRoot);
  expect(r.status).toBe(0);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ autoCompact: { future: 12, idleHours: 3 }, autoUpdate: { floka: false }, pushAllAsks: true });
});

test("[验收线 2] config migration is explicit, observes without writes, and refuses missing approval", async () => {
  const { migrateConfig } = await import("../src/lib/floka-config/items.ts");
  const f = fixture();
  let raw: any = { autoUpdate: { claudestra: false, extra: 23 }, custom: { keep: 42 } };
  let writes = 0;
  const io = { path: join(f.oldRoot, "config.json"), read: async () => structuredClone(raw), write: async (value: any) => { raw = value; writes++; } };
  for (const mode of [undefined, "off", "observe", "on"]) {
    const r = await migrateConfig({ config: { rename: { config: mode } }, txId: "config-1", journalDir: f.journalDir, io });
    expect(r.status).toBe(mode === "observe" ? "observed" : mode === "on" ? "refused" : "off");
    expect(writes).toBe(0);
    expect(existsSync(f.journalDir)).toBe(false);
  }
  const o = { config: { rename: { config: "on" } }, txId: "config-1", journalDir: f.journalDir, io,
    authorize: async (item: string, txId: string) => item === "config" && txId === "config-1" };
  expect((await migrateConfig(o)).status).toBe("committed");
  expect(raw).toEqual({ autoUpdate: { claudestra: false, floka: false, extra: 23 }, custom: { keep: 42 } });
  expect((await migrateConfig(o)).status).toBe("committed");
  expect(writes).toBe(1);
});

test("[验收线 2] runtime transaction uses independent item approval and refuses reusing a config txId", async () => {
  const { migrateRuntime, migrateConfig } = await import("../src/lib/floka-config/items.ts");
  const { nodeAliasFs } = await import("../src/lib/floka-migration/runtime/adapters.ts");
  const f = fixture(), currentDir = join(f.home, "run"), aliasDir = join(f.home, "run-alias");
  mkdirSync(currentDir);
  writeFileSync(join(currentDir, "master.sock"), "fake-socket");
  const input = { currentDir, aliasDir, socketName: "master.sock", fs: nodeAliasFs, probe: { identify: async () => "fake-server" } };
  const common = { txId: "runtime-1", journalDir: f.journalDir, input };
  expect((await migrateRuntime({ ...common, config: { rename: { transaction: "on" } } })).status).toBe("off");
  expect((await migrateRuntime({ ...common, config: { rename: { runtime: "observe" } } })).status).toBe("observed");
  expect(existsSync(aliasDir)).toBe(false);
  expect(existsSync(f.journalDir)).toBe(false);
  const config = { rename: { runtime: "on", config: "on" } }, authorize = async () => true;
  const io = { path: join(f.oldRoot, "config.json"), read: async () => ({}), write: async () => undefined };
  expect((await migrateConfig({ ...common, config, authorize, io })).status).toBe("committed");
  expect((await migrateRuntime({ ...common, config, authorize })).status).toBe("refused");
  expect(existsSync(aliasDir)).toBe(false);
  expect((await migrateRuntime({ ...common, txId: "runtime-2", config, authorize })).status).toBe("committed");
  expect(readFileSync(join(aliasDir, "master.sock"), "utf8")).toBe("fake-socket");
});

test("[验收线 2] explicit entry delegates state grants unchanged and CLI cannot elevate config", async () => {
  const { stateCommand } = await import("../scripts/rename-floka/state-command.ts");
  const { nodeAliasFs } = await import("../src/lib/floka-migration/runtime/adapters.ts");
  const f = fixture();
  const d = { state: async (argv: string[]) => argv, config: { rename: { config: "on" } }, journalDir: f.journalDir,
    configAdapter: { path: join(f.oldRoot, "config.json"), read: async () => ({ autoUpdate: { claudestra: false } }),
      write: async () => { throw Error("must not write"); } },
    runtime: { currentDir: join(f.home, "run"), aliasDir: join(f.home, "new-run"), socketName: "master.sock", fs: nodeAliasFs,
      probe: { identify: async () => null } } };
  expect(await stateCommand(["state", "run", "report", "sum", "--grant", "single-use"], d)).toEqual(["run", "report", "sum", "--grant", "single-use"]);
  expect((await stateCommand(["config", "observe"], d) as any).status).toBe("observed");
  await expect(stateCommand(["config", "on"], d)).rejects.toThrow("SERVICES grant");
  expect(existsSync(f.journalDir)).toBe(false);
});

test("[验收线 2] skills accept both managedBy values and keep the old API value", async () => {
  const { markShadowing } = await import("../src/lib/skill-library.ts");
  const base = { runtime: "codex" as const, scope: "shared" as const, name: "fixture", description: "", dir: "fixture", linkTarget: null,
    userInvocable: true, modelInvocable: true, sameNameElsewhere: 0 };
  for (const managedBy of ["claudestra", "floka", "cc-switch", null] as const) {
    const [item] = markShadowing([{ ...base, managedBy }]);
    expect(item!.managedBy).toBe(managedBy === "floka" ? "claudestra" : managedBy);
  }
});

test("[验收线 2] lease-loss result uses disk journal step states", async () => {
  const { migrateConfig } = await import("../src/lib/floka-config/items.ts");
  const f = fixture();
  let raw: any = { autoUpdate: { claudestra: false } };
  const io = { path: join(f.oldRoot, "config.json"), read: async () => raw, write: async (value: any) => {
    raw = value;
    writeFileSync(join(f.journalDir, "config-lease.lock/owner"), "successor");
  } };
  const r = await migrateConfig({ config: { rename: { config: "on" } }, txId: "config-lease", journalDir: f.journalDir, io, authorize: async () => true });
  const j = JSON.parse(readFileSync(join(f.journalDir, "config-lease.journal.json"), "utf8"));
  expect(r.status).toBe("refused");
  expect(r.steps.map(s => s.state)).toEqual(j.steps.map((s: any) => s.state));
  expect(r.steps[0]!.state).toBe("applying");
});

test("[验收线 2] cloned config writers preserve unknown nested fields and new-only spelling", () => {
  const f = fixture(), path = join(f.oldRoot, "config.json");
  writeFileSync(path, JSON.stringify({ autoUpdate: { floka: false, extra: 8 }, autoCompact: { custom: 9, idleHours: 2 }, opaque: { keep: true } }));
  const r = child(f.home, `import {readConfig,writeConfig} from './src/lib/config-store.ts';
    const cfg=structuredClone(await readConfig()); cfg.autoCompact.idleHours=3; await writeConfig(cfg);`, f.oldRoot);
  expect(r.status).toBe(0);
  const out = JSON.parse(readFileSync(path, "utf8"));
  expect(out.autoUpdate.floka).toBe(false);
  expect(out.autoUpdate.claudestra).toBeUndefined();
  expect(out.autoUpdate.extra).toBe(8);
  expect(out.autoCompact).toMatchObject({ custom: 9, idleHours: 3 });
  expect(out.opaque).toEqual({ keep: true });
});

test("[验收线 1] a later rollback supersedes an old commit proof", async () => {
  const f = fixture();
  expect((await migrateState(f)).status).toBe("committed");
  expect((await rollbackState({ ...f, txId: "rollback-later" })).status).toBe("committed");
  // Recreating directory shape alone cannot revive a proof invalidated by a rollback.
  await f.fs.rename(f.oldRoot, f.newRoot);
  await f.fs.symlink(f.newRoot, f.oldRoot);
  expect(resolved(f)).toBe(f.oldRoot);
  expect((await migrateState({ ...f, txId: "fresh-migration" })).status).toBe("committed");
  expect(resolved(f)).toBe(f.newRoot);
});

test("[验收线 1] empty new root never causes identity creation, including no legacy root", () => {
  const f = fixture();
  rmSync(f.oldRoot, { recursive: true });
  mkdirSync(f.newRoot);
  const r = child(f.home, `import {instanceIdSync} from './src/lib/instance-id.ts'; console.log(instanceIdSync());`);
  expect(r.status).not.toBe(0);
  expect(existsSync(join(f.newRoot, "instance-id"))).toBe(false);
  expect(existsSync(join(f.oldRoot, "instance-id"))).toBe(false);
});

test("[验收线 1] an empty recreated legacy root cannot split identity from the new root", async () => {
  const f = fixture();
  await f.fs.rename(f.oldRoot, f.newRoot);
  mkdirSync(f.oldRoot);
  const r = child(f.home, `import {instanceIdSync} from './src/lib/instance-id.ts'; console.log(instanceIdSync());`);
  expect(r.status).not.toBe(0);
  expect(existsSync(join(f.oldRoot, "instance-id"))).toBe(false);
  expect(readFileSync(join(f.newRoot, "instance-id"), "utf8")).toBe("fixture-instance\n");
});

test("[验收线 1] Node/Jiti resolves the committed root without loading Bun application modules", async () => {
  const f = fixture();
  expect((await migrateState(f)).status).toBe("committed");
  const env = testChildEnv({ HOME: f.home, TMPDIR: f.home });
  delete env.CLAUDESTRA_STATE_DIR;
  delete env.FLOKA_STATE_DIR;
  const script = `const {createJiti}=require(${JSON.stringify(join(import.meta.dir, "../node_modules/jiti"))});
    const jiti=createJiti(process.cwd()+'/loader.cjs');
    const {stateDir}=jiti(${JSON.stringify(join(import.meta.dir, "../src/lib/state-dir.ts"))}); console.log(stateDir());`;
  const r = spawnSync("node", ["-e", script], { env, encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe(f.newRoot);
});

test("[验收线 1] interruption between move and alias refuses startup until recovery", async () => {
  const f = fixture();
  await expect(migrateState({ ...f, crashAt: p => { if (p === "committed:state-move") throw Error("crash"); } })).rejects.toThrow("crash");
  const r = child(f.home, `import {instanceIdSync} from './src/lib/instance-id.ts'; console.log(instanceIdSync());`);
  expect(r.status).not.toBe(0);
  expect(existsSync(f.oldRoot)).toBe(false);
  expect((await migrateState(f)).status).toBe("committed");
  expect(resolved(f)).toBe(f.newRoot);
});

for (const point of ["committed:state-move", "rollback_failed", "committed:state-unalias"]) {
  test(`[验收线 1] STATE2 entries load behind the persistent barrier after ${point}`, async () => {
    const f = fixture();
    const { maintenanceRoot, prepareMaintenanceRoot } = await import("../src/lib/state-maintenance/paths.ts");
    const { raiseBarrier } = await import("../src/lib/state-maintenance/barrier.ts");
    const root = maintenanceRoot(f.home);
    prepareMaintenanceRoot(root, [f.oldRoot, f.newRoot]);
    raiseBarrier(root, { runId: f.txId, since: Date.now(), reason: "interrupted fixture" });
    if (point === "rollback_failed") renameSync(join(root, "control/barrier.json"), join(root, "control/barrier.json.tmp"));
    if (point.includes("unalias")) expect((await migrateState(f)).status).toBe("committed");
    const action = point.includes("unalias") ? rollbackState : migrateState;
    if (point === "rollback_failed") {
      let asks = 0;
      const writers = { activeWriters: async () => ++asks > 4 ? ["late fixture writer"] : [] };
      expect((await migrateState({ ...f, writers })).status).toBe("rollback_failed");
    } else {
      await expect(action({ ...f, txId: point.includes("unalias") ? "rollback-1" : f.txId,
        crashAt: p => { if (p === point) throw Error("crash"); } })).rejects.toThrow("crash");
    }
    expect(existsSync(f.oldRoot)).toBe(false);
    for (const entry of ["state-maintenance-runner", "manager"]) {
      const args = entry === "manager" ? ["state-maintenance", "status"] : ["recover", f.txId];
      const r = child(f.home, `process.argv=[process.execPath,'src/${entry}.ts',...${JSON.stringify(args)}];
        await import('./src/${entry}.ts'); console.log('import-ok');`);
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("import-ok");
      expect(existsSync(f.oldRoot)).toBe(false);
    }
    const status = child(f.home, ["src/manager.ts", "state-maintenance", "status"]);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout).ok).toBe(true);
    expect(existsSync(f.oldRoot)).toBe(false);
    for (const body of [
      `const {instanceIdSync}=await import('./src/lib/instance-id.ts'); instanceIdSync();`,
      `const {instanceKeySync}=await import('./src/lib/instance-key.ts'); instanceKeySync();`,
      `const {setLang}=await import('./src/lib/config-store.ts'); await setLang('en');`,
    ]) {
      const r = child(f.home, body);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/maintenance|维护/);
      expect(existsSync(f.oldRoot)).toBe(false);
    }
    for (const entry of ["bridge", "launcher", "cron", "scheduler", "channel-server", "manager"]) {
      const r = child(f.home, [`src/${entry}.ts`, ...(entry === "manager" ? ["auto-update", "claudestra", "on"] : [])]);
      expect(r.status).not.toBe(0);
      expect(r.stderr.trim()).toBe("状态迁移维护未完成，请到维护页恢复");
      expect(existsSync(f.oldRoot)).toBe(false);
    }
    expect(readFileSync(join(f.newRoot, "instance-id"), "utf8")).toBe("fixture-instance\n");
    // The existing STATE1 compensation can still return the data: no startup writer recreated its destination.
    expect((await recoverState({ ...f, txId: point.includes("unalias") ? "rollback-1" : f.txId },
      point.includes("unalias") ? "rollback" : "migrate")).status).toBe("rolled_back");

  });
}

test("[验收线 1] warm resolution avoids content reads and observes in-process config, journal and identity changes", async () => {
  const f = fixture();
  expect((await migrateState(f)).status).toBe("committed");
  for (let i = 0; i < 80; i++) writeFileSync(join(f.journalDir, `config-${i}.journal.json`), JSON.stringify({ plan: ["config.brand"] }));
  const r = child(f.home, `
    const fs=require('node:fs'), crypto=require('node:crypto');
    const counts={read:0,list:0,key:0};
    for (const [obj,key,counter] of [[fs,'readFileSync','read'],[fs,'readdirSync','list'],[crypto,'createPrivateKey','key']]) {
      const original=obj[key]; obj[key]=(...args)=>{ counts[counter]++; return original(...args); };
    }
    const {defaultStateRoot}=await import('./src/lib/floka-config/default-root.ts');
    const home=${JSON.stringify(f.home)}, old=${JSON.stringify(f.oldRoot)}, next=${JSON.stringify(f.newRoot)};
    const root=()=>defaultStateRoot(home,old), results=[root()];
    counts.read=counts.list=counts.key=0;
    for(let i=0;i<10;i++) results.push(root());
    const warm={...counts};
    const config=next+'/config.json', journal=${JSON.stringify(join(f.journalDir, "run-1.journal.json"))};
    const original=fs.readFileSync(journal,'utf8');
    fs.renameSync(config,config+'.target'); fs.symlinkSync(config+'.target',config);
    fs.writeFileSync(config,JSON.stringify({rename:{state:'off'}})); results.push(root());
    fs.writeFileSync(config,JSON.stringify({rename:{state:'on'}})); results.push(root());
    fs.writeFileSync(journal,original.replace('"committed"','"running"')); results.push(root());
    fs.writeFileSync(journal,original); results.push(root());
    const extra=${JSON.stringify(join(f.journalDir, "later.journal.json"))};
    fs.writeFileSync(extra,'{}'); results.push(root()); fs.unlinkSync(extra); results.push(root());
    fs.writeFileSync(next+'/instance-id','changed-instance'); results.push(root());
    console.log(JSON.stringify({warm,results}));`);
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out.warm).toEqual({ read: 0, list: 0, key: 0 });
  expect(out.results).toEqual([...Array(11).fill(f.newRoot), f.oldRoot, f.newRoot, f.oldRoot, f.newRoot, f.oldRoot, f.newRoot, f.oldRoot]);
});
