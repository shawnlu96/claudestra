/**
 * Manual scheduler memory probe (macOS, not in CI): replays the scheduler's per-pass read paths against a snapshot of the
 * state dir, in a child per step whose CLAUDESTRA_STATE_DIR / CLAUDESTRA_RUNTIME_DIR point at the snapshot (no tmux, no
 * manager child, no network, no writes outside the snapshot). Session files are looked up under the real $HOME read-only,
 * because that lookup is the path being measured.
 *
 *   bun scripts/scheduler-memory-probe.ts snapshot --to DIR [--from STATE_DIR (default: the production state dir, read only)]
 *   bun scripts/scheduler-memory-probe.ts run --state DIR [--root CHECKOUT] [--rounds 100] [--warmup 20] [--steps all|view,lifecycle,...] [--limit-mb 5]
 *
 * snapshot creates DIR 0700 (an existing DIR must be an empty 0700 dir of this user), writes every copy 0600 and refuses a
 * symlinked target path (any link, so give the real path: /private/tmp/…): the copies hold the whole private ledger and journal.
 * Each step prints one JSON line: WebKit malloc and phys footprint before / after `rounds` passes (after `warmup` unmeasured
 * passes and a forced GC), the JS heap size, and pass = total phys footprint growth < limit (verdict). Steps: see STEPS
 * below. --root picks the checkout whose src/ is imported, so the same snapshot can be replayed against the base and the fix.
 */
import { Database } from "bun:sqlite";
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stateDirIn } from "../src/lib/state-dir.ts";

const STEPS = ["view", "lifecycle", "lockyield", "registry", "activity"] as const;
type Step = typeof STEPS[number];

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

/**
 * A symlink anywhere on the target path could redirect the private copy: every link is refused, system ones included
 * (macOS /tmp, /var → /private/…), so the target is given by its real path (e.g. /private/tmp/…).
 */
function refuseSymlinks(p: string): void {
  for (let cur = resolve(p); ; cur = dirname(cur)) {
    const st = lstatSync(cur, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) throw new Error(`snapshot target path has a symlink: ${cur} (give the real path, e.g. /private/tmp/…)`);
    if (cur === dirname(cur)) return;
  }
}

/** A new 0700 dir; an existing one is accepted only if it is ours, private and empty (else something else could read or plant files) */
function privateDir(p: string): void {
  try { mkdirSync(p, { mode: 0o700 }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const st = lstatSync(p);
    if (!st.isDirectory() || st.uid !== process.getuid!() || (st.mode & 0o077) !== 0 || readdirSync(p).length)
      throw new Error(`snapshot target exists and is not an empty private directory of this user: ${p}`);
  }
  chmodSync(p, 0o700); // mkdir's mode is masked by umask; this makes the bit pattern exact either way
}

/** Copied files 0600, dirs 0700; symlinks in the source are skipped (chmod would follow them back into the source) */
function copyPrivate(src: string, dst: string): void {
  const st = lstatSync(src);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    privateDir(dst);
    for (const name of readdirSync(src)) copyPrivate(join(src, name), join(dst, name));
  } else if (st.isFile()) {
    copyFileSync(src, dst, constants.COPYFILE_EXCL);
    chmodSync(dst, 0o600);
  }
}

/**
 * Copies only what the read paths need, private to this user (the ledger and journal hold the whole private ledger, not just
 * scheduler facts: whole-file copies keep the replay faithful to every table the steps read). sqlite files go through a
 * read-only connection's serialize, so the source is never opened read-write.
 */
export function snapshot(from: string, to: string): void {
  refuseSymlinks(to);
  privateDir(to);
  for (const d of ["lend", "run"]) privateDir(join(to, d));
  for (const f of ["registry.json", "scheduler.json", "projects.json", "acp-activity", join("lend", "claude-config")])
    if (existsSync(join(from, f))) copyPrivate(join(from, f), join(to, f));
  for (const f of ["ledger.sqlite", join("lend", "journal.sqlite")]) {
    if (!existsSync(join(from, f))) continue;
    const db = new Database(join(from, f), { readonly: true });
    try { writeFileSync(join(to, f), db.serialize(), { mode: 0o600, flag: "wx" }); } finally { db.close(); }
    chmodSync(join(to, f), 0o600);
    const copy = new Database(join(to, f)); // the copy only: a WAL header would make the child's read-only open need a -shm file
    try { copy.run("PRAGMA journal_mode = DELETE"); } finally { copy.close(); }
  }
}

/** macOS footprint(1): total phys footprint and the WebKit malloc dirty size, in MB */
/** footprint(1) output → total phys footprint and the WebKit malloc dirty size, in MB (NaN = line missing) */
export function parseFootprint(out: string): { physMb: number; webkitMb: number } {
  const mb = (n: string, u: string) => Number(n) * ({ B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024 } as Record<string, number>)[u]!;
  const phys = /Footprint:\s+([\d.]+)\s+(B|KB|MB|GB)/.exec(out);
  const webkit = /^\s*([\d.]+)\s+(B|KB|MB|GB)\s+.*WebKit malloc\s*$/m.exec(out);
  return { physMb: phys ? mb(phys[1]!, phys[2]!) : NaN, webkitMb: webkit ? mb(webkit[1]!, webkit[2]!) : NaN };
}

/**
 * The pass line is the total phys footprint: a leak in any native region counts, not only WebKit malloc, so a WebKit drop
 * cannot hide growth elsewhere. An unreadable footprint (NaN) fails.
 */
export function verdict(before: { physMb: number; webkitMb: number }, after: { physMb: number; webkitMb: number }, limitMb: number):
  { growthMb: number; webkitGrowthMb: number; pass: boolean } {
  const growth = after.physMb - before.physMb;
  return { growthMb: +growth.toFixed(1), webkitGrowthMb: +(after.webkitMb - before.webkitMb).toFixed(1), pass: growth < limitMb };
}

const footprint = () => parseFootprint(Bun.spawnSync(["footprint", "-p", String(process.pid)]).stdout.toString());

async function settle(): Promise<void> {
  for (let k = 0; k < 4; k++) { Bun.gc(true); await Bun.sleep(500); }
}

async function child(root: string, step: Step, rounds: number, warmup: number, limitMb: number): Promise<void> {
  const lib = (m: string) => import(pathToFileURL(join(root, "src", "lib", m)).href);
  const db = new Database(join(process.env.CLAUDESTRA_STATE_DIR!, "ledger.sqlite"), { readonly: true });
  const config = (await lib("scheduler-config.ts")).readSchedulerConfig();
  const projects = Object.keys(config.projects);
  const run: Record<Step, () => Promise<unknown>> = {
    view: async () => { const { schedulerProjectView } = await lib("ledger-scheduler.ts"); for (const p of projects) schedulerProjectView(db, p); },
    lifecycle: async () => (await lib("agent-lifecycle-deps.ts")).lifecycleSnapshot(db, config.lifecycle),
    lockyield: async () => (await lib("scheduler-lock-yield-agents.ts")).localAgents(db, Date.now(), 30 * 60_000),
    registry: async () => {
      const { readJsonLenient } = await lib("state-file.ts"), { REGISTRY_PATH } = await lib("registry.ts");
      await readJsonLenient(REGISTRY_PATH, null); (await lib("scheduler-lock-yield-agents.ts")).registryAgents();
    },
    activity: async () => {
      const { readActivity } = await lib("agent-supervisor-activity.ts"), { normalizeRegistryAgents, REGISTRY_PATH } = await lib("registry.ts");
      const { readJsonLenient } = await lib("state-file.ts");
      for (const a of normalizeRegistryAgents(await readJsonLenient(REGISTRY_PATH, null))) readActivity(a.name);
    },
  };
  for (let i = 0; i < warmup; i++) await run[step](); // module load, JIT, sqlite page cache, allocator pools settle before the baseline
  await settle();
  const before = footprint(), t0 = performance.now();
  for (let i = 0; i < rounds; i++) await run[step]();
  const ms = Math.round((performance.now() - t0) / rounds);
  await settle();
  const after = footprint();
  const { heapSize } = (await import("bun:jsc")).heapStats();
  console.log(JSON.stringify({ step, rounds, warmup, msPerRound: ms, webkitMb: [before.webkitMb, after.webkitMb], physMb: [before.physMb, after.physMb],
    ...verdict(before, after, limitMb), heapMb: +(heapSize / 1048576).toFixed(1), rssMb: Math.round(process.memoryUsage().rss / 1048576) }));
  db.close();
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "snapshot") {
    const to = resolve(arg("to")!);
    snapshot(resolve(arg("from", stateDirIn(homedir()))!), to);
    return console.log(JSON.stringify({ ok: true, snapshot: to }));
  }
  if (cmd === "child") return child(arg("root")!, arg("step") as Step, Number(arg("rounds")), Number(arg("warmup")), Number(arg("limit-mb")));
  if (cmd !== "run") throw new Error("usage: snapshot --to DIR | run --state DIR [--root CHECKOUT] [--rounds 100] [--warmup 20] [--steps all|a,b] [--limit-mb 5]");
  if (process.platform !== "darwin") throw new Error("macOS only (footprint)");
  const state = resolve(arg("state")!), root = resolve(arg("root", resolve(import.meta.dir, ".."))!);
  const steps = (arg("steps", "all") === "all" ? [...STEPS] : arg("steps")!.split(",")) as Step[];
  let ok = true;
  for (const step of steps) {
    const p = Bun.spawnSync([process.execPath, "--no-env-file", import.meta.path, "child", "--root", root, "--step", step,
      "--rounds", arg("rounds", "100")!, "--warmup", arg("warmup", "20")!, "--limit-mb", arg("limit-mb", "5")!], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin", HOME: homedir(), CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(state, "run") },
      stdout: "pipe", stderr: "pipe",
    });
    const line = p.stdout.toString().trim().split("\n").pop() ?? "";
    if (p.exitCode !== 0 || !line.startsWith("{")) { ok = false; console.log(JSON.stringify({ step, error: p.stderr.toString().slice(-500) })); continue; }
    console.log(line);
    ok &&= JSON.parse(line).pass === true;
  }
  process.exit(ok ? 0 : 1);
}

if (import.meta.main) await main();
