/** CFGWRITE1 · config write lock, missing-file snapshot and the configWriteSerialize switch (src/lib/floka-config/write-lock.ts). */
import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { AppConfig } from "../src/lib/config-store.ts";
import { ConfigChangedError, retryConfigWrite } from "../src/lib/floka-config/retry.ts";
import { configView, writeCompatibleConfig } from "../src/lib/floka-config/store.ts";
import { configLockPath, configWriteModeAt, configWriteTarget, ConfigWriteLockTimeoutError, holdsConfigWriteLock, useConfigWritePort,
  withConfigWriteLock } from "../src/lib/floka-config/write-lock.ts";
import type { ObservedAction } from "../src/lib/recovery-policy.ts";
import { testChildEnv } from "./test-env.ts";

type Mode = "on" | "observe" | "off";
const roots: string[] = [];
afterEach(() => { useConfigWritePort(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function setup(mode: Mode | (() => Mode), initial?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "floka-config-race-")); roots.push(dir);
  const path = join(dir, "config.json");
  if (initial !== undefined) writeFileSync(path, JSON.stringify(initial));
  const samples: ObservedAction[] = [];
  useConfigWritePort({ mode: typeof mode === "function" ? mode : () => mode, observe: (a) => { samples.push(a); }, waitMs: 400, staleMs: 30_000 });
  return { path, samples, disk: () => JSON.parse(readFileSync(path, "utf8")) };
}
const base = (): AppConfig => ({ autoUpdate: { claudestra: true, claudeCode: true }, lang: "zh" });
/** What config-store's readConfig hands a setter: a view with its source snapshot (missing file = exists false). */
function read(path: string): AppConfig {
  if (!existsSync(path)) return configView(undefined, base(), false);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return configView(raw, { ...base(), ...raw, autoUpdate: { ...base().autoUpdate, ...raw.autoUpdate } });
}
const deferred = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

test("[验收线 1] read on a missing file, someone else creates it: on refuses the stale write, the replay keeps both", async () => {
  const f = setup("on");
  const cfg = read(f.path);
  writeFileSync(f.path, JSON.stringify({ quotaLive: false, future: { x: 1 } }));
  cfg.lang = "en";
  await expect(writeCompatibleConfig(f.path, cfg)).rejects.toBeInstanceOf(ConfigChangedError);
  expect(f.disk()).toEqual({ quotaLive: false, future: { x: 1 } });
  const again = read(f.path); again.lang = "en";
  await writeCompatibleConfig(f.path, again);
  expect(f.disk()).toEqual({ quotaLive: false, future: { x: 1 }, lang: "en" });
});

test("[验收线 1] first write on a missing file stores only the edit; deletion after the read is a version change", async () => {
  const f = setup("on");
  const cfg = read(f.path); cfg.pushAllAsks = true;
  await writeCompatibleConfig(f.path, cfg);
  expect(f.disk()).toEqual({ pushAllAsks: true });
  const next = read(f.path); next.lang = "en";
  unlinkSync(f.path);
  await expect(writeCompatibleConfig(f.path, next)).rejects.toBeInstanceOf(ConfigChangedError);
  expect(existsSync(f.path)).toBe(false);
});

test("[验收线 1] off keeps the baseline: a file created after a missing read is overwritten by the full view", async () => {
  const f = setup("off");
  const cfg = read(f.path);
  writeFileSync(f.path, JSON.stringify({ quotaLive: false }));
  cfg.lang = "en";
  await writeCompatibleConfig(f.path, cfg);
  expect(f.disk()).toEqual({ quotaLive: false, autoUpdate: { claudestra: true, claudeCode: true }, lang: "en" });
});

test("[验收线 1] two writers read the same version and edit different fields: replay keeps both", async () => {
  const f = setup("on", { lang: "zh", opaque: { keep: true } });
  const a = read(f.path), b = read(f.path);
  a.quotaLive = false; b.pushNoContent = true;
  await writeCompatibleConfig(f.path, a);
  await expect(writeCompatibleConfig(f.path, b)).rejects.toBeInstanceOf(ConfigChangedError);
  await retryConfigWrite(async () => { const c = read(f.path); c.pushNoContent = true; await writeCompatibleConfig(f.path, c); });
  expect(f.disk()).toEqual({ lang: "zh", opaque: { keep: true }, quotaLive: false, pushNoContent: true });
});

test("[验收线 1] a writer paused after its check holds the lock: the other waits, rereads and refuses its stale view", async () => {
  const f = setup("on", { lang: "zh" });
  f.samples.length = 0;
  const gate = deferred(), checked = deferred();
  const b = read(f.path); b.pushAllAsks = true;
  const first = withConfigWriteLock(f.path, async () => {
    const a = read(f.path); a.quotaLive = false;
    checked.open(); await gate.p; // checked, not yet written
    await writeCompatibleConfig(f.path, a);
  });
  await checked.p;
  let second: unknown = "pending";
  const pending = writeCompatibleConfig(f.path, b).then(() => (second = "ok"), (e) => (second = e));
  await Bun.sleep(100);
  expect(second).toBe("pending");
  expect(f.disk()).toEqual({ lang: "zh" });
  gate.open(); await first; await pending;
  expect(second).toBeInstanceOf(ConfigChangedError);
  expect(f.disk()).toEqual({ lang: "zh", quotaLive: false });
});

test("[验收线 1] first setter on a fresh state root: on creates the missing parent before locking, like off", async () => {
  for (const mode of ["on", "off"] as const) {
    const f = setup(mode);
    useConfigWritePort({ mode: () => mode, waitMs: 0 });
    const path = join(f.path, "..", "fresh", "state", "config.json");
    const cfg = read(path); cfg.lang = "en";
    await writeCompatibleConfig(path, cfg);
    expect(JSON.parse(readFileSync(path, "utf8")).lang).toBe("en");
    expect(existsSync(configLockPath(path))).toBe(false);
  }
});

test("[验收线 1] every spelling of one config shares one lock: file alias, directory alias, relative path, missing file", () => {
  const f = setup("on", { lang: "zh" });
  const dir = resolve(f.path, "..");
  symlinkSync(f.path, join(dir, "alias.json"));
  symlinkSync(dir, join(dir, "dir-alias"));
  const target = configWriteTarget(f.path);
  expect(configWriteTarget(join(dir, "alias.json"))).toBe(target);
  expect(configWriteTarget(join(dir, "dir-alias", "config.json"))).toBe(target);
  expect(configWriteTarget(relative(process.cwd(), f.path))).toBe(target);
  expect(configWriteTarget(join(dir, "dir-alias", "new", "x.json"))).toBe(join(resolve(target, ".."), "new", "x.json"));
  expect(configLockPath(join(dir, "alias.json"))).toBe(`${target}.lock`);
});

test("[验收线 1] writer A via a symlink alias paused after its check; B via the real path waits and refuses its stale view", async () => {
  const f = setup("on", { lang: "zh" });
  const alias = join(resolve(f.path, ".."), "alias.json");
  symlinkSync(f.path, alias);
  const gate = deferred(), checked = deferred();
  const b = read(f.path); b.pushAllAsks = true;
  const first = withConfigWriteLock(alias, async () => {
    expect(holdsConfigWriteLock(f.path)).toBe(true);
    const a = read(alias); a.quotaLive = false;
    checked.open(); await gate.p;
    await writeCompatibleConfig(alias, a);
  });
  await checked.p;
  let second: unknown = "pending";
  const pending = writeCompatibleConfig(f.path, b).then(() => (second = "ok"), (e) => (second = e));
  await Bun.sleep(100);
  expect(second).toBe("pending");
  gate.open(); await first; await pending;
  expect(second).toBeInstanceOf(ConfigChangedError);
  expect(f.disk()).toEqual({ lang: "zh", quotaLive: false });
  await retryConfigWrite(async () => { const c = read(f.path); c.pushAllAsks = true; await writeCompatibleConfig(f.path, c); });
  expect(f.disk()).toEqual({ lang: "zh", quotaLive: false, pushAllAsks: true });
});

test("[验收线 2] lock timeout fails loudly and writes nothing; the timeout is not a retried conflict", async () => {
  const f = setup("on", { lang: "zh" });
  mkdirSync(configLockPath(f.path)); writeFileSync(join(configLockPath(f.path), "owner"), "other-process");
  const cfg = read(f.path); cfg.lang = "en";
  let attempts = 0;
  const t = Date.now();
  const e = await retryConfigWrite(async () => { attempts++; await writeCompatibleConfig(f.path, cfg); }).catch((x) => x);
  expect(e).toBeInstanceOf(ConfigWriteLockTimeoutError);
  expect(attempts).toBe(1);
  expect(Date.now() - t).toBeGreaterThanOrEqual(300);
  expect(f.disk()).toEqual({ lang: "zh" });
});

test("[验收线 2] the lock is re-entrant inside its holder and released after a failure", async () => {
  const f = setup("on", { lang: "zh" });
  await expect(withConfigWriteLock(f.path, async () => {
    expect(holdsConfigWriteLock(f.path)).toBe(true);
    await withConfigWriteLock(f.path, async () => { const c = read(f.path); c.lang = "en"; await writeCompatibleConfig(f.path, c); });
    throw new Error("boom");
  })).rejects.toThrow("boom");
  expect(existsSync(configLockPath(f.path))).toBe(false);
  expect(holdsConfigWriteLock(f.path)).toBe(false);
  expect(f.disk().lang).toBe("en");
});

test("[验收线 2] corrupt file is refused, unknown fields and the legacy/new brand spelling survive a locked write", async () => {
  const f = setup("on");
  writeFileSync(f.path, "{ half");
  const c = read(join(f.path + ".none")); c.lang = "en";
  await expect(writeCompatibleConfig(f.path, c)).rejects.toThrow();
  expect(readFileSync(f.path, "utf8")).toBe("{ half");
  writeFileSync(f.path, JSON.stringify({ autoUpdate: { floka: false, future: 3 }, unknown: { deep: [1] } }));
  const raw = JSON.parse(readFileSync(f.path, "utf8"));
  const view = configView(raw, { ...base(), autoUpdate: { claudestra: false, claudeCode: true } });
  view.autoUpdate.claudestra = true;
  await writeCompatibleConfig(f.path, view);
  expect(f.disk()).toEqual({ autoUpdate: { floka: true, future: 3 }, unknown: { deep: [1] } });
});

test("[验收线 2] conflicting brand values are still refused under the lock", async () => {
  const f = setup("on", { autoUpdate: { claudestra: true, floka: false } });
  const c = read(f.path);
  await expect(writeCompatibleConfig(f.path, c)).rejects.toThrow("conflicts");
});

test("[验收线 3] observe writes exactly like off and records one deduplicated sample without values", async () => {
  const results: Record<string, unknown> = {};
  for (const mode of ["off", "observe"] as const) {
    const f = setup(mode);
    for (let i = 0; i < 2; i++) {
      rmSync(f.path, { force: true });
      const cfg = read(f.path);
      writeFileSync(f.path, JSON.stringify({ groqApiKey: "secret-value" }));
      cfg.lang = "en";
      await writeCompatibleConfig(f.path, cfg);
    }
    results[mode] = f.disk();
    if (mode === "off") expect(f.samples).toEqual([]);
    else {
      expect(f.samples.length).toBe(1);
      expect(f.samples[0]).toMatchObject({ mechanism: "configWriteSerialize", target: "config.json", data: { action: "missing-changed" } });
      expect(JSON.stringify(f.samples)).not.toContain("secret-value");
      expect(JSON.stringify(f.samples)).not.toContain(tmpdir());
    }
  }
  expect(results.observe).toEqual(results.off);
});

test("[验收线 3] mode is re-read before every write: switching on → off → on needs no restart", async () => {
  let mode: Mode = "on";
  const f = setup(() => mode);
  for (const [m, refused] of [["on", true], ["off", false], ["on", true]] as const) {
    mode = m;
    rmSync(f.path, { force: true });
    const cfg = read(f.path);
    writeFileSync(f.path, JSON.stringify({ quotaLive: false }));
    cfg.lang = "en";
    const r = await writeCompatibleConfig(f.path, cfg).then(() => false, (e) => e instanceof ConfigChangedError);
    expect(r).toBe(refused);
    expect(existsSync(configLockPath(f.path))).toBe(false);
  }
});

test("[验收线 3] recovery-policy file: default on, key overrides project mode, invalid file is off", () => {
  const dir = mkdtempSync(join(tmpdir(), "floka-config-policy-")); roots.push(dir);
  const p = join(dir, "recovery-policy.json");
  expect(configWriteModeAt(p)).toBe("on");
  writeFileSync(p, JSON.stringify({ projects: { "claude-orchestrator": { mode: "observe" } } }));
  expect(configWriteModeAt(p)).toBe("observe");
  writeFileSync(p, JSON.stringify({ projects: { "claude-orchestrator": { mode: "observe", keys: { configWriteSerialize: "off" } } } }));
  expect(configWriteModeAt(p)).toBe("off");
  writeFileSync(p, JSON.stringify({ projects: { other: { mode: "off" } } }));
  expect(configWriteModeAt(p)).toBe("on");
  writeFileSync(p, "{");
  expect(configWriteModeAt(p)).toBe("off");
});

test("[验收线 3] rename config transaction applies under the same lock and waits for another writer", async () => {
  const { migrateConfig } = await import("../src/lib/floka-config/items.ts");
  const f = setup("on", { autoUpdate: { claudestra: false } });
  const journalDir = join(mkdtempSync(join(tmpdir(), "floka-config-journal-")), "j"); roots.push(resolve(journalDir, ".."));
  let lockedWrites = 0;
  const io = { path: f.path, read: async () => JSON.parse(readFileSync(f.path, "utf8")),
    write: async (v: Record<string, unknown>) => { if (holdsConfigWriteLock(f.path)) lockedWrites++; writeFileSync(f.path, JSON.stringify(v)); } };
  const gate = deferred(), inside = deferred();
  const other = withConfigWriteLock(f.path, async () => { inside.open(); await gate.p; });
  await inside.p;
  let done = false;
  const tx = migrateConfig({ config: { rename: { config: "on" } }, txId: "config-1", journalDir, io,
    authorize: async () => true }).then((r) => { done = true; return r; });
  await Bun.sleep(100);
  expect(done).toBe(false);
  gate.open(); await other;
  expect((await tx).status).toBe("committed");
  expect(lockedWrites).toBe(1);
  expect(f.disk()).toEqual({ autoUpdate: { claudestra: false, floka: false } });
});

/** Real setters in separate processes against one missing config.json: every setter's field survives. */
function childArgs(home: string, code: string) {
  return { args: ["--no-env-file", "--config=/dev/null", "-e", code],
    opts: { cwd: resolve(import.meta.dir, ".."), env: testChildEnv({ HOME: home, TMPDIR: home, CLAUDESTRA_RUNTIME_DIR: join(home, "run") }) } };
}
function home(policy?: unknown) {
  const h = mkdtempSync(join(tmpdir(), "floka-config-procs-")); roots.push(h);
  mkdirSync(join(h, ".claude-orchestrator"));
  if (policy) writeFileSync(join(h, ".claude-orchestrator", "recovery-policy.json"), JSON.stringify(policy));
  return h;
}
async function race(h: string, calls: string[]) {
  const runs = calls.map((call) => new Promise<{ code: number | null; err: string }>((done) => {
    const { args, opts } = childArgs(h, `const c=await import('./src/lib/config-store.ts'); ${call}`);
    const p = spawn(process.execPath, args, opts); let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => done({ code, err }));
  }));
  return Promise.all(runs);
}

test("[验收线 1] two processes create and edit config.json at once: on keeps every field", async () => {
  const h = home();
  const r = await race(h, [
    "for (let i=0;i<8;i++) await c.setArchiveRetention(10+i);",
    "for (let i=0;i<8;i++) await c.setPushAllAsks(i%2===1);",
    "for (let i=0;i<8;i++) await c.setGroqApiKey('k'+i);",
  ]);
  for (const x of r) expect(x.err && x.code !== 0 ? x.err : x.code).toBe(0);
  const disk = JSON.parse(readFileSync(join(h, ".claude-orchestrator", "config.json"), "utf8"));
  expect(disk).toMatchObject({ archiveRetentionDays: 17, pushAllAsks: true, groqApiKey: "k7" });
  expect(existsSync(join(h, ".claude-orchestrator", "config.json.lock"))).toBe(false);
}, 60_000);

test("[验收线 2] barrier: a locked setter is refused during state-root maintenance and is not retried", () => {
  const h = home();
  const { args, opts } = childArgs(h, `const {maintenanceRoot}=await import('./src/lib/state-maintenance/paths.ts');
    const {mkdirSync,writeFileSync}=await import('node:fs'); const {dirname,join}=await import('node:path');
    const bp=join(maintenanceRoot(),'control','barrier.json'); mkdirSync(dirname(bp),{recursive:true});
    writeFileSync(bp, JSON.stringify({runId:'r',since:Date.now(),reason:'test'}));
    const c=await import('./src/lib/config-store.ts');
    try { await c.setLang('en'); console.log('wrote'); } catch(e) { console.log(e.message); }`);
  const r = spawnSync(process.execPath, args, { ...opts, encoding: "utf8", timeout: 20_000 });
  expect(r.stderr && r.status !== 0 ? r.stderr : r.status).toBe(0);
  expect(r.stdout).toContain("maintenance in progress");
  expect(existsSync(join(h, ".claude-orchestrator", "config.json"))).toBe(false);
});

test("[验收线 3] off via recovery-policy.json is the baseline path: no lock file is ever taken", () => {
  const h = home({ projects: { "claude-orchestrator": { keys: { configWriteSerialize: "off" } } } });
  const { args, opts } = childArgs(h, `const {existsSync}=await import('node:fs');
    const w=await import('./src/lib/floka-config/write-lock.ts'); const c=await import('./src/lib/config-store.ts');
    let seen=false; await w.withConfigWriteLock(c.CONFIG_PATH, async()=>{ seen=existsSync(w.configLockPath(c.CONFIG_PATH)); await c.setLang('en'); });
    console.log(JSON.stringify({mode:w.configWriteMode(),seen,cfg:(await c.readConfig()).lang}));`);
  const r = spawnSync(process.execPath, args, { ...opts, encoding: "utf8", timeout: 20_000 });
  expect(r.stderr && r.status !== 0 ? r.stderr : r.status).toBe(0);
  expect(JSON.parse(r.stdout.trim().split("\n").pop()!)).toEqual({ mode: "off", seen: false, cfg: "en" });
});
