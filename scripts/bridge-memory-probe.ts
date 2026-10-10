/**
 * Run with bun --no-env-file --config=/dev/null scripts/bridge-memory-probe.ts help.
 * No inspector, heap dump, signal, bridge connection, production import or process discovery.
 * Replay imports only the selected checkout's event-bus in fresh children with empty credentials.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { freemem, loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  analyzeMemory, memoryCounters, memoryValues, parseMemoryPoint, probeMode,
  type MemoryPoint, type MemoryCounters,
} from "../src/lib/bridge-memory-metrics.ts";

const HELP = `Read-only bridge memory diagnostics (JSON; bytes and seconds).
  identity --pid PID
  sample --pid PID --identity TOKEN [--version COMMIT] [--count 12] [--interval-ms 1000] [--warmup 4]
  analyze --input REPORT_JSON (sample, replay worker or comparison)
  replay --old-root CHECKOUT --new-root CHECKOUT
  bg-activity --root CHECKOUT [--rounds 40]   (macOS only; manual, not in CI)
  stats-cycles --root CHECKOUT [--cycles 20]  (macOS only; manual, not in CI; writes ~330MB fixture to a temp dir, removed after)
  All commands accept --mode observe|on|off (default observe; on also only observes).
Use --no-env-file --config=/dev/null. identity must be captured for the intended process at start.
External sample never attaches to JS: heap/external/arrayBuffers/counters are null, not zero.
macOS identity has one-second resolution; Linux identity uses boot ID + start ticks.
Replay: event-bus only, fixed workload v1, sequential old/new children, forced GC in children only.
Scenarios: steady, churn-cleanup, retention-control (intentional synthetic retention).
No scenario starts the bridge, opens sockets, reads real state or constitutes field attribution.
An event-bus plateau does not establish a bridge plateau or explain an old/new production RSS gap.
Report includes runtime/source hashes, baseline/warmup/measurement points and host swap/load.
Use identical runtime and repeat with old/new roots swapped to assess order/host interference.
Six measured points minimum; sub-tolerance rising traces need a longer window and remain unknown.
Unknown/failure is retained. No report proves a leak.
stats-cycles: fake HOME with CC sessions sized like production (22 idle 12MB + 1 busy 60MB all-in-week); each cycle appends
to 3 busy files then runs the checkout's computeAgentStats (the Stop-hook dashboard path). Total footprint, not just WebKit malloc:
peak = highest post-cycle footprint; pass = peak <= settled baseline + 50MB and growth after N cycles < 5MB. Run old and new roots.
bg-activity: fake HOME (588 project dirs, ~450KB registry with CJK text, 11 codex/pi agents + 1 Claude Code agent), real bg-activity tick
from the checkout, WebKit malloc (footprint) before/after; pass = growth < 5MB. Run old and new roots for before/after.`;
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const SCENARIOS = ["steady", "churn-cleanup", "retention-control"] as const;
type Scenario = typeof SCENARIOS[number];
const WORKLOAD = { id: "event-bus-v1", warmup: 4, measured: 8, agents: 4, eventsPerAgent: 128, payloadBytes: 2048, intervalMs: 25 };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, {
    cwd, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C", TZ: "UTC", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
}

function pidNumber(value: string | undefined): number {
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) throw new Error("invalid_pid");
  return Number(value);
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : Number(value);
  if ((value !== undefined && !/^\d+$/.test(value)) || !Number.isInteger(n) || n < min || n > max) throw new Error("invalid_option");
  return n;
}

function identity(pid: number): { token: string; precision: string } {
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
    if (!/^\d+$/.test(start)) throw new Error("identity_unavailable");
    return { token: hash(`${pid}:${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}`), precision: "kernel_ticks" };
  }
  if (process.platform !== "darwin") throw new Error("unsupported_platform");
  const start = run("/bin/ps", ["-p", String(pid), "-o", "lstart="]);
  if (!/^[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(start)) throw new Error("identity_unavailable");
  return { token: hash(`${pid}:${start}`), precision: "one_second_pid_reuse_within_second_not_excluded" };
}

function elapsedSeconds(text: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text);
  if (!m) throw new Error("metrics_unavailable");
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

function hostMetrics(): MemoryPoint["host"] {
  let swapUsedBytes: number | null = null;
  try {
    if (process.platform === "linux") {
      const info = readFileSync("/proc/meminfo", "utf8");
      const total = /^SwapTotal:\s+(\d+) kB$/m.exec(info), free = /^SwapFree:\s+(\d+) kB$/m.exec(info);
      if (total && free) swapUsedBytes = (Number(total[1]) - Number(free[1])) * 1024;
    } else if (process.platform === "darwin") {
      const used = /used = ([\d.]+)([KMG])/.exec(run("/usr/sbin/sysctl", ["-n", "vm.swapusage"]));
      if (used) swapUsedBytes = Number(used[1]) * 1024 ** ({ K: 1, M: 2, G: 3 }[used[2]] ?? 0);
    }
  } catch {
    // Swap is optional host context: permission/OS failures remain null in the report, never become zero.
  }
  return { freeBytes: freemem(), load1: loadavg()[0], swapUsedBytes };
}

function externalPoint(pid: number, token: string, index: number, started: number, warmup: number): MemoryPoint {
  if (identity(pid).token !== token) throw new Error("identity_changed");
  const fields = run("/bin/ps", ["-p", String(pid), "-o", "rss=", "-o", "etime="]).split(/\s+/);
  if (fields.length !== 2 || !/^\d+$/.test(fields[0])) throw new Error("metrics_unavailable");
  const host = hostMetrics();
  if (identity(pid).token !== token) throw new Error("identity_changed");
  return {
    index, atMs: Date.now(), elapsedMs: performance.now() - started, uptimeSeconds: elapsedSeconds(fields[1]),
    phase: index === 0 ? "baseline" : index <= warmup ? "warmup" : "measure", pid, identity: token,
    memory: memoryValues({ rss: Number(fields[0]) * 1024 }), counters: memoryCounters(), host,
  };
}

function safeError(error: unknown): string {
  const msg = error instanceof Error ? error.message : "";
  return ["invalid_mode", "invalid_option", "invalid_pid", "invalid_point", "identity_changed", "identity_unavailable",
    "unsupported_platform", "metrics_unavailable", "version_unavailable", "worker_failed", "invalid_report"].includes(msg) ? msg : "probe_failed";
}

async function sample(flags: Record<string, string>) {
  const pid = pidNumber(flags.pid), token = flags.identity;
  if (!token || !HASH.test(token) || (flags.version !== undefined && !SHA.test(flags.version))) throw new Error("invalid_option");
  const count = integer(flags.count, 12, 1, 1000), interval = integer(flags["interval-ms"], 1000, 10, 60_000);
  const warmup = integer(flags.warmup, 4, 0, 1000), started = performance.now(), points: MemoryPoint[] = [];
  let failure: string | null = null;
  for (let i = 0; i < count; i++) {
    if (i) await Bun.sleep(interval);
    try { points.push(externalPoint(pid, token, i, started, warmup)); }
    catch (error) { failure = safeError(error); break; }
  }
  return {
    schema: 1, kind: "external", mode: probeMode(flags.mode), version: flags.version ?? null,
    versionSource: flags.version ? "operator_supplied_not_verified" : "unknown", runtime: null,
    identityPrecision: process.platform === "linux" ? "kernel_ticks" : "one_second", intervalMs: interval,
    status: failure ? "failed" : "complete", failure, points, analysis: analyzeMemory(points),
    unavailable: ["target_js_heap", "target_external", "target_array_buffers", "target_counters", "target_runtime_version"],
  };
}

function sourceVersion(root: string) {
  const commit = run("/usr/bin/git", ["--no-optional-locks", "rev-parse", "HEAD"], root);
  if (!SHA.test(commit)) throw new Error("version_unavailable");
  return {
    commit, dirty: run("/usr/bin/git", ["--no-optional-locks", "status", "--porcelain", "--untracked-files=no"], root).length > 0,
    eventBusSha256: hash(readFileSync(join(root, "src/bridge/event-bus.ts"))),
    bun: Bun.version, platform: process.platform, arch: process.arch,
  };
}

type EventBus = Pick<typeof import("../src/bridge/event-bus.ts"), "emitEvent" | "forgetAgent" | "subscribeEvents" | "subscriberCount" | "replayEventsSince">;

function replayRound(bus: EventBus, scenario: Scenario, round: number, retained: Buffer[]): void {
  const stop = bus.subscribeEvents({}, () => {});
  try {
    for (let agent = 0; agent < WORKLOAD.agents; agent++) {
      const name = `synthetic-${scenario === "churn-cleanup" ? round : 0}-${agent}`;
      for (let event = 0; event < WORKLOAD.eventsPerAgent; event++) {
        const text = `${round}:${agent}:${event}:`.padEnd(WORKLOAD.payloadBytes, "x");
        bus.emitEvent({ agent: name, chatId: "", type: "assistant_text", data: { text } });
      }
      if (scenario === "churn-cleanup") bus.forgetAgent(name);
    }
    // Positive control lives only in this synthetic child; it is never a suggested production change.
    if (scenario === "retention-control") retained.push(Buffer.alloc(2 * 1024 * 1024, round + 1));
  } finally { stop(); }
}

async function replayWorker(root: string, scenario: Scenario) {
  const version = sourceVersion(root);
  const bus: EventBus = await import(pathToFileURL(join(root, "src/bridge/event-bus.ts")).href);
  const token = identity(process.pid).token, start = performance.now(), points: MemoryPoint[] = [], retained: Buffer[] = [];
  for (let round = 0; round <= WORKLOAD.warmup + WORKLOAD.measured; round++) {
    if (round) replayRound(bus, scenario, round, retained);
    const counters: MemoryCounters = memoryCounters({
      emittedEvents: round * WORKLOAD.agents * WORKLOAD.eventsPerAgent,
      bufferedEvents: bus.replayEventsSince(0).length, subscribers: bus.subscriberCount(),
      controlObjects: retained.length, controlBytes: retained.length * 2 * 1024 * 1024,
    });
    Bun.gc(true);
    await Bun.sleep(WORKLOAD.intervalMs);
    const memory = memoryValues(process.memoryUsage());
    points.push({
      index: round, atMs: Date.now(), elapsedMs: performance.now() - start, uptimeSeconds: process.uptime(),
      phase: round === 0 ? "baseline" : round <= WORKLOAD.warmup ? "warmup" : "measure",
      pid: process.pid, identity: token, memory, counters, host: hostMetrics(),
    });
  }
  // Keep control allocations reachable through the final sample, even under an optimizing runtime.
  const controlChecksum = retained.reduce((sum, b) => sum + b[0], 0);
  return { schema: 1, kind: "replay", scenario, version, workload: WORKLOAD, gc: "forced_before_each_sample",
    controlChecksum, status: "complete", points, analysis: analyzeMemory(points) };
}

function isolatedEnv(root: string): Record<string, string> {
  for (const name of ["home", "state", "runtime", "tmp"]) mkdirSync(join(root, name), { mode: 0o700 });
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: join(root, "home"), TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
    CLAUDESTRA_STATE_DIR: join(root, "state"), CLAUDESTRA_RUNTIME_DIR: join(root, "runtime"),
    XDG_CONFIG_HOME: join(root, "home"), XDG_CACHE_HOME: join(root, "tmp"),
    CLAUDESTRA_TEST: "1", NODE_ENV: "test", BRIDGE_PORT: "9", BRIDGE_URL: "ws://127.0.0.1:9",
  };
}

async function isolatedChild(args: string[], timeoutMs: number): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), "bridge-memory-"));
  try {
    const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", import.meta.path, ...args], {
      cwd: dir, env: isolatedEnv(dir), stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
    // Only our newly spawned child can be terminated; no supplied or discovered PID is signalled.
    const timeout = setTimeout(() => child.kill(), timeoutMs);
    try {
      const output = await new Response(child.stdout).text();
      if (await child.exited !== 0 || output.length > 2 * 1024 * 1024) throw new Error("worker_failed");
      // Imported product modules may log to stdout; the report is always the last line.
      return JSON.parse(output.trimEnd().split("\n").at(-1) ?? "");
    } finally { clearTimeout(timeout); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function isolatedReplay(root: string, scenario: Scenario) {
  return await isolatedChild(["worker", "--root", root, "--scenario", scenario], 30_000) as Awaited<ReturnType<typeof replayWorker>>;
}

const BG = { projectDirs: 588, foreignAgents: 11, registryPadding: 440 * 1024, settleRounds: 4 };

/** WebKit malloc dirty bytes of this process (macOS footprint); the leak lives there, invisible to the JS heap. */
function webkitMallocBytes(): number {
  const out = run("/usr/bin/footprint", ["-p", String(process.pid)]);
  const m = /^\s*([\d.]+) (B|KB|MB|GB)\s.*WebKit malloc\s*$/m.exec(out);
  if (!m) throw new Error("metrics_unavailable");
  return Number(m[1]) * 1024 ** ({ B: 0, KB: 1, MB: 2, GB: 3 }[m[2]] ?? 0);
}

async function settledWebkit(): Promise<number> {
  for (let i = 0; i < BG.settleRounds; i++) { Bun.gc(true); await Bun.sleep(1200); }
  return webkitMallocBytes();
}

/** Fake state mirroring production shape: codex/pi sessions never exist under ~/.claude/projects, so pre-fix code falls back to the full scan.
 *  CJK text matters: JSON.parse then yields 16-bit strings, the Bun 1.3.14 leak trigger; an ASCII-only registry does not leak. */
function bgFixture(home: string, stateDir: string, slug: (cwd: string) => string): void {
  const projects = join(home, ".claude", "projects");
  for (let i = 0; i < BG.projectDirs; i++) mkdirSync(join(projects, `-fake-project-${i}`), { recursive: true });
  const agents: Record<string, unknown> = {};
  const entry = (i: number, runtime?: string) => ({ status: "active", channelId: `local-${i}`, cwd: join(home, "work", `a${i}`),
    sessionId: crypto.randomUUID(), ...(runtime ? { runtime } : {}) });
  for (let i = 0; i < BG.foreignAgents; i++) agents[`agent-foreign-${i}`] = entry(i, i % 2 ? "pi" : "codex");
  agents["agent-cc"] = entry(BG.foreignAgents);
  const cc = agents["agent-cc"] as { cwd: string; sessionId: string };
  const ccDir = join(projects, slug(cc.cwd));
  mkdirSync(ccDir, { recursive: true });
  writeFileSync(join(ccDir, `${cc.sessionId}.jsonl`), "");
  for (let i = 0; i < BG.registryPadding / 1250; i++) {
    agents[`agent-stopped-${i}`] = { status: "stopped", purpose: "执行者".repeat(130), sessionId: crypto.randomUUID() };
  }
  writeFileSync(join(stateDir, "registry.json"), JSON.stringify({ agents }));
}

async function bgWorker(root: string, rounds: number) {
  if (process.platform !== "darwin") throw new Error("unsupported_platform");
  const home = process.env.HOME!, stateDir = process.env.CLAUDESTRA_STATE_DIR!;
  const { projectsSlug }: { projectsSlug: (cwd: string) => string } = await import(pathToFileURL(join(root, "src/lib/jsonl-cost.ts")).href);
  bgFixture(home, stateDir, projectsSlug);
  const shellDir = join(process.env.TMPDIR!, "tasks");
  const watcher: { pollBgActivitiesForTest: (o: object) => Promise<void> } =
    await import(pathToFileURL(join(root, "src/bridge/bg-activity-watcher.ts")).href);
  let clock = Date.now();
  const tick = () => watcher.pollBgActivitiesForTest({ now: () => (clock += 10_000), shellDir: () => shellDir });
  await tick(); // first-scan baseline allocations are not the leak
  const before = await settledWebkit();
  for (let i = 0; i < rounds; i++) await tick();
  const after = await settledWebkit();
  const growth = after - before;
  return { schema: 1, kind: "bg-activity", version: run("/usr/bin/git", ["--no-optional-locks", "rev-parse", "HEAD"], root), bun: Bun.version,
    fixture: BG, rounds, webkitBeforeBytes: before, webkitAfterBytes: after, growthBytes: growth,
    perTickBytes: Math.round(growth / rounds), pass: growth < 5 * 1024 * 1024, status: "complete" };
}

const STATS = { idleAgents: 22, idleBytes: 12 * 1024 * 1024, busyBytes: 60 * 1024 * 1024, busyAgents: 3, appendBytes: 256 * 1024,
  warmupCycles: 2, cycleGapMs: 60_000, peakBudget: 50 * 1024 * 1024, growthBudget: 5 * 1024 * 1024 };
const STATS_NOW = Date.parse("2026-10-08T12:00:00.000Z");

/** Whole-process footprint (dirty + compressed, all VM tags): the spike lives in the allocator region, not WebKit malloc. */
function footprintBytes(): number {
  const m = /Footprint: ([\d.]+) (KB|MB|GB)/.exec(run("/usr/bin/footprint", ["-p", String(process.pid)]));
  if (!m) throw new Error("metrics_unavailable");
  return Math.round(Number(m[1]) * 1024 ** ({ KB: 1, MB: 2, GB: 3 }[m[2]] ?? 0));
}

async function settledFootprint(): Promise<number> {
  for (let i = 0; i < BG.settleRounds; i++) { Bun.gc(true); await Bun.sleep(1200); }
  return footprintBytes();
}

/** ~2KB CC jsonl records with CJK text (JSON.parse/UTF-16 promotion like real sessions), timestamps spread from fromMs to toMs. */
function statsRecords(bytes: number, fromMs: number, toMs: number, tag: string): string {
  const body = "会话正文，中文内容让字符串走十六位存储。".repeat(40);
  const out: string[] = [];
  let size = 0, i = 0;
  const n = Math.ceil(bytes / 2200);
  while (size < bytes) {
    const ts = new Date(fromMs + ((toMs - fromMs) * i) / n).toISOString();
    const line = i % 2
      ? JSON.stringify({ type: "assistant", timestamp: ts, requestId: `req_${tag}_${i}`, message: { id: `msg_${tag}_${i}`, model: "claude-opus-5-5",
        content: [{ type: "text", text: body }], usage: { input_tokens: 10, cache_read_input_tokens: 90_000 + i, cache_creation_input_tokens: 5, output_tokens: 30 } } })
      : JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: body } });
    out.push(line);
    size += Buffer.byteLength(line) + 1;
    i++;
  }
  return out.join("\n") + "\n";
}

type StatsAgent = { name: string; cwd: string; sessionId: string; status: string; path: string };

function statsFixture(home: string, slug: (cwd: string) => string): StatsAgent[] {
  const day = 86_400_000, agents: StatsAgent[] = [];
  for (let i = 0; i < STATS.idleAgents + 1; i++) {
    const cwd = join(home, "work", `a${i}`), sessionId = crypto.randomUUID(), dir = join(home, ".claude", "projects", slug(cwd));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${sessionId}.jsonl`);
    // idle: a month of history, the 8MB tail crosses the week floor; busy (last): a week's worth, the window expands to the whole file
    writeFileSync(path, i < STATS.idleAgents ? statsRecords(STATS.idleBytes, STATS_NOW - 30 * day, STATS_NOW - day, `a${i}`)
      : statsRecords(STATS.busyBytes, STATS_NOW - 4 * day, STATS_NOW - 60_000, `a${i}`));
    agents.push({ name: `agent-${i}`, cwd, sessionId, status: "active", path });
  }
  return agents;
}

async function statsWorker(root: string, cycles: number) {
  if (process.platform !== "darwin") throw new Error("unsupported_platform");
  const { projectsSlug }: { projectsSlug: (cwd: string) => string } = await import(pathToFileURL(join(root, "src/lib/jsonl-cost.ts")).href);
  const stats: { computeAgentStats: (a: object[], w: object) => Promise<{ week: { requests: number } }[]> } =
    await import(pathToFileURL(join(root, "src/lib/agent-stats.ts")).href);
  const agents = statsFixture(process.env.HOME!, projectsSlug);
  const busy = agents.slice(-STATS.busyAgents);
  const window = { dayStart: STATS_NOW - 12 * 3_600_000, weekStart: STATS_NOW - 5 * 86_400_000, weekSource: "quota" };
  // Synthetic clock: each cycle is a minute apart, like Stop hooks on a busy machine (old code's 5s cache bucket never hits).
  let clock = STATS_NOW;
  Date.now = () => clock;
  const cycle = async (k: number) => {
    clock += STATS.cycleGapMs;
    for (const a of busy) appendFileSync(a.path, statsRecords(STATS.appendBytes, clock - 30_000, clock, `${a.name}-c${k}`));
    return (await stats.computeAgentStats(agents, window)).reduce((n, s) => n + s.week.requests, 0);
  };
  for (let k = 0; k < STATS.warmupCycles; k++) await cycle(k);
  const baseline = await settledFootprint();
  const post: number[] = [];
  let requests = 0;
  for (let k = 0; k < cycles; k++) {
    requests = await cycle(STATS.warmupCycles + k);
    post.push(footprintBytes());
  }
  const settled = await settledFootprint();
  const peak = Math.max(...post);
  return { schema: 1, kind: "stats-cycles", version: run("/usr/bin/git", ["--no-optional-locks", "rev-parse", "HEAD"], root), bun: Bun.version,
    fixture: STATS, cycles, weekRequestsLastCycle: requests, baselineBytes: baseline, postCycleBytes: post, peakBytes: peak, settledBytes: settled,
    peakOverBaselineBytes: peak - baseline, growthBytes: settled - baseline,
    pass: peak - baseline <= STATS.peakBudget && settled - baseline < STATS.growthBudget, status: "complete" };
}

async function statsCycles(flags: Record<string, string>) {
  if (!flags.root) throw new Error("invalid_option");
  const cycles = integer(flags.cycles, 20, 1, 500);
  return isolatedChild(["stats-worker", "--root", resolve(flags.root), "--cycles", String(cycles)], 600_000);
}

async function bgActivity(flags: Record<string, string>) {
  if (!flags.root) throw new Error("invalid_option");
  const rounds = integer(flags.rounds, 40, 1, 1000);
  return isolatedChild(["bg-worker", "--root", resolve(flags.root), "--rounds", String(rounds)], 600_000);
}

async function replay(flags: Record<string, string>) {
  if (!flags["old-root"] || !flags["new-root"]) throw new Error("invalid_option");
  const runs: { side: "old" | "new"; scenario: Scenario; result?: Awaited<ReturnType<typeof replayWorker>>; failure?: string }[] = [];
  for (const side of ["old", "new"] as const) {
    for (const scenario of SCENARIOS) {
      try { runs.push({ side, scenario, result: await isolatedReplay(resolve(flags[`${side}-root`]), scenario) }); }
      catch (error) { runs.push({ side, scenario, failure: safeError(error) }); }
    }
  }
  const comparisons = SCENARIOS.map((scenario) => {
    const old = runs.find((r) => r.side === "old" && r.scenario === scenario)?.result;
    const next = runs.find((r) => r.side === "new" && r.scenario === scenario)?.result;
    return { scenario, comparable: Boolean(old && next), old: old?.analysis.classification ?? "unknown",
      new: next?.analysis.classification ?? "unknown", sameSource: old && next ? old.version.eventBusSha256 === next.version.eventBusSha256 : null };
  });
  return { schema: 1, kind: "comparison", comparisonScope: "event_bus_only", mode: probeMode(flags.mode), workload: WORKLOAD, runs, comparisons,
    status: runs.some((r) => r.failure) ? "failed" : "complete", productionAttribution: "unknown",
    limitations: ["event_bus_only", "synthetic_load", "sequential_order_effect_possible", "external_process_influence_unmeasured",
      "rss_includes_allocator_and_runtime", "field_evidence_not_collected", "no_product_fix_proposed",
      "event_bus_plateau_does_not_establish_bridge_plateau"] };
}

/** Version objects come from replay reports; validate each leaf instead of reflecting arbitrary source text. */
function reportVersion(value: unknown) {
  if (typeof value === "string") return SHA.test(value) ? value : null;
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return {
    commit: typeof v.commit === "string" && SHA.test(v.commit) ? v.commit : null,
    dirty: typeof v.dirty === "boolean" ? v.dirty : null,
    eventBusSha256: typeof v.eventBusSha256 === "string" && HASH.test(v.eventBusSha256) ? v.eventBusSha256 : null,
    bun: typeof v.bun === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v.bun) ? v.bun : null,
    platform: typeof v.platform === "string" && ["darwin", "linux"].includes(v.platform) ? v.platform : null,
    arch: typeof v.arch === "string" && ["arm64", "x64"].includes(v.arch) ? v.arch : null,
  };
}

function reportProvenance(input: Record<string, unknown>) {
  const workload = input.workload && typeof input.workload === "object" ? input.workload as Record<string, unknown> : {};
  const interval = input.intervalMs ?? workload.intervalMs;
  return {
    version: reportVersion(input.version),
    versionSource: input.versionSource === "operator_supplied_not_verified" ? input.versionSource : "unknown",
    intervalMs: typeof interval === "number" && Number.isSafeInteger(interval)
      && interval > 0 && interval <= 60_000 ? interval : null,
    identityPrecision: typeof input.identityPrecision === "string"
      && ["kernel_ticks", "one_second", "one_second_pid_reuse_within_second_not_excluded"].includes(input.identityPrecision)
      ? input.identityPrecision : "unknown",
  };
}

function reportObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_report");
  return value as Record<string, unknown>;
}

function analyzeReport(value: unknown) {
  const input = reportObject(value);
  if (!Array.isArray(input.points) || input.points.length > 1000) throw new Error("invalid_report");
  const points = input.points.map(parseMemoryPoint);
  return { schema: 1, kind: "analysis", status: input.status === "failed" ? "failed" : "analyzed",
    sourceFailure: input.status === "failed" ? safeError(new Error(String(input.failure ?? input.sourceFailure))) : null,
    ...reportProvenance(input), points, analysis: analyzeMemory(points) };
}

/** Each child retains its own PID, source and failure; never merge old/new points into one trend. */
function analyzeComparison(input: Record<string, unknown>) {
  if (!Array.isArray(input.runs) || !input.runs.length || input.runs.length > SCENARIOS.length * 2) throw new Error("invalid_report");
  const seen = new Set<string>();
  const runs = input.runs.map((value: unknown) => {
    const run = reportObject(value);
    if ((run.side !== "old" && run.side !== "new") || !SCENARIOS.includes(run.scenario as Scenario)) throw new Error("invalid_report");
    const key = `${run.side}:${run.scenario}`;
    if (seen.has(key)) throw new Error("invalid_report");
    seen.add(key);
    const meta = { side: run.side, scenario: run.scenario as Scenario };
    if (run.failure !== undefined) return { ...meta, failure: safeError(new Error(String(run.failure))) };
    return { ...meta, result: analyzeReport(run.result) };
  });
  return { schema: 1, kind: "comparison_analysis", comparisonScope: input.comparisonScope === "event_bus_only" ? "event_bus_only" : "unknown",
    ...reportProvenance(input), runs,
    status: input.status === "failed" || runs.some((run) => "failure" in run || run.result.status === "failed") ? "failed" : "analyzed",
    productionAttribution: "unknown",
    limitations: ["event_bus_only", "synthetic_load", "sequential_order_effect_possible", "external_process_influence_unmeasured",
      "event_bus_plateau_does_not_establish_bridge_plateau"] };
}

function analyzeFile(path: string | undefined) {
  if (!path) throw new Error("invalid_option");
  const file = Bun.file(path);
  if (file.size > 8 * 1024 * 1024) throw new Error("invalid_report");
  const input = reportObject(JSON.parse(readFileSync(path, "utf8")));
  return input.kind === "comparison" || input.kind === "comparison_analysis" ? analyzeComparison(input) : analyzeReport(input);
}

const ALLOWED: Record<string, string[]> = {
  identity: ["pid"], sample: ["pid", "identity", "version", "count", "interval-ms", "warmup"],
  analyze: ["input"], replay: ["old-root", "new-root"], worker: ["root", "scenario"], help: [],
  "bg-activity": ["root", "rounds"], "bg-worker": ["root", "rounds"],
  "stats-cycles": ["root", "cycles"], "stats-worker": ["root", "cycles"],
};

/** Exported so tests invoke the same parser/dispatcher as the standalone CLI. */
export async function memoryProbeMain(args: string[]): Promise<unknown> {
  const [command = "help", ...rest] = args, flags: Record<string, string> = {};
  if (!ALLOWED[command] || rest.length % 2) throw new Error("invalid_option");
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].slice(2);
    if (!rest[i].startsWith("--") || (!ALLOWED[command].includes(key) && key !== "mode") || flags[key] !== undefined) throw new Error("invalid_option");
    flags[key] = rest[i + 1];
  }
  const mode = probeMode(flags.mode);
  if (mode === "off") return { schema: 1, mode, status: "off" };
  if (command === "help") return { help: HELP };
  if (command === "identity") { const pid = pidNumber(flags.pid); return { schema: 1, pid, ...identity(pid) }; }
  if (command === "sample") return sample(flags);
  if (command === "analyze") return analyzeFile(flags.input);
  if (command === "replay") return replay(flags);
  if (command === "bg-activity") return bgActivity(flags);
  if (command === "stats-cycles") return statsCycles(flags);
  if (command === "stats-worker") {
    if (!flags.root || process.env.CLAUDESTRA_TEST !== "1") throw new Error("invalid_option");
    return statsWorker(flags.root, integer(flags.cycles, 20, 1, 500));
  }
  if (command === "bg-worker") {
    if (!flags.root || process.env.CLAUDESTRA_TEST !== "1") throw new Error("invalid_option");
    return bgWorker(flags.root, integer(flags.rounds, 40, 1, 1000));
  }
  if (!flags.root || !SCENARIOS.includes(flags.scenario as Scenario) || process.env.CLAUDESTRA_TEST !== "1") throw new Error("invalid_option");
  return replayWorker(flags.root, flags.scenario as Scenario);
}

if (import.meta.main) {
  try {
    const result = await memoryProbeMain(process.argv.slice(2));
    console.log(JSON.stringify(result));
    if ((result as { status?: string }).status === "failed") process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ schema: 1, status: "failed", failure: safeError(error) }));
    process.exitCode = 1;
  }
}
