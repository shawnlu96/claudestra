/**
 * Manual scheduler memory probe (macOS, not in CI): replays the scheduler's per-pass read paths against a snapshot of the
 * state dir, in a child per step whose CLAUDESTRA_STATE_DIR / CLAUDESTRA_RUNTIME_DIR point at the snapshot (no tmux, no
 * manager child, no network, no writes outside the snapshot). Session files are looked up under the real $HOME read-only,
 * because that lookup is the path being measured.
 *
 *   bun scripts/scheduler-memory-probe.ts snapshot --to DIR [--from ~/.claude-orchestrator]
 *   bun scripts/scheduler-memory-probe.ts run --state DIR [--root CHECKOUT] [--rounds 100] [--steps all|view,lifecycle,...] [--limit-mb 5]
 *
 * Each step prints one JSON line: WebKit malloc and phys footprint before / after `rounds` passes (after forced GC), the
 * JS heap size, and pass = growth < limit. Steps: see STEPS below. --root picks the checkout whose src/ is imported, so the
 * same snapshot can be replayed against the base and the fix.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const STEPS = ["view", "lifecycle", "lockyield", "registry", "activity"] as const;
type Step = typeof STEPS[number];

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

/** Copies only what the read paths need; sqlite files go through a read-only connection's serialize (never opened read-write). */
function snapshot(from: string, to: string): void {
  mkdirSync(join(to, "lend"), { recursive: true });
  mkdirSync(join(to, "run"), { recursive: true });
  for (const f of ["registry.json", "scheduler.json", "projects.json"]) if (existsSync(join(from, f))) copyFileSync(join(from, f), join(to, f));
  for (const d of ["acp-activity", join("lend", "claude-config")]) if (existsSync(join(from, d))) cpSync(join(from, d), join(to, d), { recursive: true });
  for (const f of ["ledger.sqlite", join("lend", "journal.sqlite")]) {
    if (!existsSync(join(from, f))) continue;
    const db = new Database(join(from, f), { readonly: true });
    try { writeFileSync(join(to, f), db.serialize()); } finally { db.close(); }
    const copy = new Database(join(to, f)); // the copy only: a WAL header would make the child's read-only open need a -shm file
    try { copy.run("PRAGMA journal_mode = DELETE"); } finally { copy.close(); }
  }
  console.log(JSON.stringify({ ok: true, snapshot: to }));
}

/** macOS footprint(1): total phys footprint and the WebKit malloc dirty size, in MB */
function footprint(): { physMb: number; webkitMb: number } {
  const out = Bun.spawnSync(["footprint", "-p", String(process.pid)]).stdout.toString();
  const mb = (n: string, u: string) => (u === "KB" ? Number(n) / 1024 : u === "GB" ? Number(n) * 1024 : u === "B" ? 0 : Number(n));
  const phys = /Footprint:\s+([\d.]+)\s+(B|KB|MB|GB)/.exec(out);
  const webkit = /^\s*([\d.]+)\s+(B|KB|MB|GB)\s+.*WebKit malloc\s*$/m.exec(out);
  return { physMb: phys ? mb(phys[1]!, phys[2]!) : NaN, webkitMb: webkit ? mb(webkit[1]!, webkit[2]!) : NaN };
}

async function settle(): Promise<void> {
  for (let k = 0; k < 4; k++) { Bun.gc(true); await Bun.sleep(500); }
}

async function child(root: string, step: Step, rounds: number, limitMb: number): Promise<void> {
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
  await run[step](); // warm-up: module load, JIT, caches
  await settle();
  const before = footprint(), t0 = performance.now();
  for (let i = 0; i < rounds; i++) await run[step]();
  const ms = Math.round((performance.now() - t0) / rounds);
  await settle();
  const after = footprint(), growth = after.webkitMb - before.webkitMb;
  const { heapSize } = (await import("bun:jsc")).heapStats();
  console.log(JSON.stringify({ step, rounds, msPerRound: ms, webkitMb: [before.webkitMb, after.webkitMb], physMb: [before.physMb, after.physMb],
    growthMb: +growth.toFixed(1), heapMb: +(heapSize / 1048576).toFixed(1), rssMb: Math.round(process.memoryUsage().rss / 1048576), pass: growth < limitMb }));
  db.close();
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "snapshot") return snapshot(resolve(arg("from", join(homedir(), ".claude-orchestrator"))!), resolve(arg("to")!));
  if (cmd === "child") return child(arg("root")!, arg("step") as Step, Number(arg("rounds")), Number(arg("limit-mb")));
  if (cmd !== "run") throw new Error("usage: snapshot --to DIR | run --state DIR [--root CHECKOUT] [--rounds 100] [--steps all|a,b] [--limit-mb 5]");
  if (process.platform !== "darwin") throw new Error("macOS only (footprint)");
  const state = resolve(arg("state")!), root = resolve(arg("root", resolve(import.meta.dir, ".."))!);
  const steps = (arg("steps", "all") === "all" ? [...STEPS] : arg("steps")!.split(",")) as Step[];
  let ok = true;
  for (const step of steps) {
    const p = Bun.spawnSync([process.execPath, "--no-env-file", import.meta.path, "child", "--root", root, "--step", step,
      "--rounds", arg("rounds", "100")!, "--limit-mb", arg("limit-mb", "5")!], {
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

await main();
