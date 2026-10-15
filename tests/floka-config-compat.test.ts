import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { testChildEnv } from "./test-env.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "floka-config-compat-"));
  roots.push(home);
  const root = join(home, ".claude-orchestrator");
  mkdirSync(root);
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify({ autoUpdate: { claudestra: false }, opaque: { keep: 7 } }));
  return { home, root, path };
}
function child(f: ReturnType<typeof fixture>, code: string | string[]) {
  const env = testChildEnv({ HOME: f.home, TMPDIR: f.home, CLAUDESTRA_RUNTIME_DIR: join(f.home, "run") });
  return spawnSync(process.execPath, ["--no-env-file", "--config=/dev/null", ...(typeof code === "string" ? ["-e", code] : code)], {
    cwd: resolve(import.meta.dir, ".."), env, encoding: "utf8", timeout: 20_000,
  });
}

for (const legacy of [false, true]) {
  test(`[验收线 1] legacy ${legacy} wins on both readers; report is readable but never persisted`, () => {
    const f = fixture();
    const raw = JSON.stringify({ autoUpdate: { claudestra: legacy, floka: !legacy }, groqApiKey: "secret-fixture" });
    writeFileSync(f.path, raw);
    const r = child(f, `const c=await import('./src/lib/config-store.ts');
      const a=await c.readConfig(), b=c.readConfigSync();
      console.log(JSON.stringify({a:a.autoUpdate.claudestra,b:b.autoUpdate.floka,reports:[a.configConflicts,b.configConflicts]}));
      try { await c.writeConfig(a); process.exit(3); } catch(e) { console.error(e.message); }`);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.a).toBe(legacy);
    expect(out.b).toBe(legacy);
    for (const report of out.reports) {
      expect(report).toHaveLength(1);
      expect(report[0].keys).toEqual(["autoUpdate.claudestra", "autoUpdate.floka"]);
      expect(report[0].message).toContain("conflicts");
    }
    expect(r.stderr).toContain("[floka-config]");
    expect(r.stderr).not.toContain("secret-fixture");
    expect(readFileSync(f.path, "utf8")).toBe(raw);
  });
}

function barrier(f: ReturnType<typeof fixture>) {
  const control = join(f.home, ".claudestra-maintenance/state/control");
  mkdirSync(control, { recursive: true });
  writeFileSync(join(control, "barrier.json"), JSON.stringify({ runId: "fixture", since: 1, reason: "interrupted" }));
}

test("[验收线 3] a symlink to the product manager cannot bypass the persistent barrier", () => {
  const f = fixture(); barrier(f);
  const entry = join(f.home, "manager-link.ts");
  symlinkSync(resolve(import.meta.dir, "../src/manager.ts"), entry);
  const r = child(f, [entry, "auto-update", "claudestra", "on"]);
  expect(r.status).not.toBe(0);
  expect(r.stderr.trim()).toBe("状态迁移维护未完成，请到维护页恢复");
});

for (const action of ["status", "recover", "note-retry", "mode"]) {
  test(`[验收线 4] barrier startup policy for ${action} (authorization remains downstream)`, () => {
    const f = fixture(); barrier(f);
    // Supply the entry path explicitly to isolate startup policy from downstream grant checks.
    const r = child(f, `process.argv=[process.execPath,'manager.ts','state-maintenance','${action}'];
      const {maintenanceStartupRoot}=await import('./src/lib/floka-config/startup.ts');
      maintenanceStartupRoot(${JSON.stringify(f.root)},${JSON.stringify(resolve(import.meta.dir, '../src/manager.ts'))}); console.log('allowed');`);
    expect(r.status).toBe(action === "mode" ? 1 : 0);
    expect(action === "mode" ? r.stderr : r.stdout).toContain(action === "mode" ? "状态迁移维护未完成" : "allowed");
  });
}

test("[验收线 3] realpath failure fails closed behind the barrier", () => {
  const f = fixture(); barrier(f);
  const r = child(f, `const {maintenanceStartupRoot}=await import('./src/lib/floka-config/startup.ts');
    maintenanceStartupRoot(${JSON.stringify(f.root)},${JSON.stringify(join(f.home, 'missing.ts'))});`);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("状态迁移维护未完成");
});

test("[验收线 3] Bun's exact eval entry retains library semantics behind the barrier", () => {
  const f = fixture(); barrier(f);
  const r = child(f, `const {maintenanceStartupRoot}=await import('./src/lib/floka-config/startup.ts');
    maintenanceStartupRoot(${JSON.stringify(f.root)}); console.log('library allowed');`);
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe("library allowed");
});

test("[验收线 3] a different path named [eval] does not get the virtual-entry exception", () => {
  const f = fixture(); barrier(f);
  const r = child(f, `const {maintenanceStartupRoot}=await import('./src/lib/floka-config/startup.ts');
    maintenanceStartupRoot(${JSON.stringify(f.root)},${JSON.stringify(join(f.home, "[eval]"))});`);
  expect(r.status).not.toBe(0);
  expect(r.stderr.trim()).toBe("状态迁移维护未完成，请到维护页恢复");
});

test("[验收线 3] unresolved allowlist entries also fail closed", () => {
  const f = fixture(); barrier(f);
  const r = child(f, `import {mock} from 'bun:test'; const fs=await import('node:fs'), real=fs.realpathSync;
    mock.module('node:fs',()=>({...fs,realpathSync:path=>{ if(path.endsWith('/cron.ts')) throw Error('unreadable'); return real(path); }}));
    const {maintenanceStartupRoot}=await import('./src/lib/floka-config/startup.ts');
    maintenanceStartupRoot(${JSON.stringify(f.root)},${JSON.stringify(resolve(import.meta.dir, "../src/launcher.ts"))});`);
  expect(r.status).not.toBe(0);
  expect(r.stderr.trim()).toBe("状态迁移维护未完成，请到维护页恢复");
});
