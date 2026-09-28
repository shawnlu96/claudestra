#!/usr/bin/env bun
/**
 * 沙箱 bridge：一条命令在本机起一个与线上完全隔开的 Claudestra（docs/architecture/sandbox.md）。
 *
 *   bun run sandbox up [--port N] [--root DIR] [--static DIR]   起沙箱 bridge（Web-only，默认端口 23900）
 *   bun run sandbox manager <子命令…>                            在沙箱里跑 manager（create / kill / list / token-add …）
 *   bun run sandbox status | down | clean                        看状态 / 停掉 bridge 与沙箱 tmux / 停掉并删沙箱目录
 *   bun run sandbox env                                          打印沙箱环境（export 行，手动调试用）
 *
 * 所有沙箱侧的进程都由本脚本用**从零构建的环境**拉起（lib/sandbox-env.ts），并带 `--no-env-file`：
 * 调用者自己的 BRIDGE_URL / DISCORD_CHANNEL_ID 和任何 .env 都进不去。生产改过的端口 / 目录从生产的
 * launchd plist 与 .env 里读出来，连同默认值一起作为拒绝清单传给沙箱里每个进程（lib/sandbox.ts）。
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { homedir } from "os";
import { canonicalPath, pathsOverlap, sandboxDirProblems, sandboxStaticDirProblem, SANDBOX_FLAG } from "../src/lib/sandbox.js";
import {
  productionDeny, sandboxEnv, sandboxLayout, sandboxManagerRefusal, zdotdirFiles, type ProductionDeny, type SandboxLayout,
} from "../src/lib/sandbox-env.js";
import { DEFAULT_BRIDGE_PORT } from "../src/lib/bridge-url.js";
import { readDotenvFileSync } from "../src/lib/env-file.js";
import { DEFAULT_RUNTIME_DIR, stateDirIn } from "../src/lib/paths.js";
import { SRC_DIR } from "../src/lib/repo-root.js";

const DEFAULT_PORT = 23900;
const MARKER = ".claudestra-sandbox";
const INNER = "__inner";
const BRIDGE_PLIST = join(homedir(), "Library", "LaunchAgents", "com.claudestra.bridge.plist");

interface Opts {
  port: number;
  root: string;
  staticDir?: string;
  rest: string[];
  deny: ProductionDeny;
}

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function run(cmd: string[]): string {
  try {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return r.exitCode === 0 ? r.stdout.toString() : "";
  } catch {
    return ""; // 可执行文件不存在（Linux 上没有 plutil / lsof）：当作没查到，调用方各有兜底
  }
}

/** 生产配置：launchd plist 的环境与工作目录、生产仓库与本仓库主工作树的 .env（都只读） */
function discoverProduction(): ProductionDeny {
  const sources: Array<Record<string, string>> = [];
  const repos = new Set<string>();
  const plist = existsSync(BRIDGE_PLIST) ? run(["plutil", "-convert", "json", "-o", "-", BRIDGE_PLIST]) : "";
  if (plist) {
    try {
      const j = JSON.parse(plist) as { EnvironmentVariables?: Record<string, string>; WorkingDirectory?: string };
      if (j.EnvironmentVariables) sources.push(j.EnvironmentVariables);
      if (j.WorkingDirectory) repos.add(j.WorkingDirectory);
    } catch {
      /* plist 不是预期结构：少一份来源，默认值与 .env 仍在清单里 */
    }
  }
  const common = run(["git", "-C", SRC_DIR, "rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  if (common) repos.add(dirname(common));
  for (const r of repos) {
    const env = readDotenvFileSync(join(r, ".env"));
    if (env) sources.push(env);
  }
  return productionDeny(sources, { port: DEFAULT_BRIDGE_PORT, dirs: [stateDirIn(homedir()), DEFAULT_RUNTIME_DIR] });
}

function parseOpts(argv: string[]): Opts {
  let port = Number(process.env.CLAUDESTRA_SANDBOX_PORT) || DEFAULT_PORT;
  let root = "";
  let staticDir: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--port") port = Number(argv[++i]);
    else if (a === "--root") root = resolve(argv[++i] ?? "");
    else if (a === "--static") staticDir = resolve(argv[++i] ?? "");
    else rest.push(a);
  }
  const deny = discoverProduction();
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) fail(`--port 不合法：${port}`);
  if (deny.ports.includes(port)) fail(`${port} 是生产在用的端口（${deny.ports.join(", ")}），沙箱不能用`);
  return { port, root: root || `/tmp/claudestra-sandbox-${port}`, staticDir, rest, deny };
}

function envFor(o: Opts, layout: SandboxLayout): Record<string, string> {
  return sandboxEnv(process.env, { layout, port: o.port, staticDir: o.staticDir, deny: o.deny });
}

/** 在沙箱环境里跑一个 bun 进程（继承 stdio），返回退出码 */
function runInSandbox(o: Opts, layout: SandboxLayout, args: string[], quiet = false): number {
  const r = Bun.spawnSync([process.execPath, "--no-env-file", ...args], {
    cwd: layout.root, env: envFor(o, layout), stdin: "inherit", stdout: quiet ? "pipe" : "inherit", stderr: quiet ? "pipe" : "inherit",
  });
  return r.exitCode ?? 1;
}

/** 标记文件：记着建它时的真实根目录。down / clean 只认标记与 --root 对得上的目录 */
function markerProblem(layout: SandboxLayout): string | null {
  try {
    const m = JSON.parse(readFileSync(join(layout.root, MARKER), "utf8")) as { root?: string };
    return m.root === canonicalPath(layout.root) ? null : `${layout.root} 的沙箱标记记的是 ${m.root}，对不上`;
  } catch {
    return `${layout.root} 没有可读的沙箱标记（${MARKER}），不是本脚本建的沙箱`;
  }
}

/** 进程的工作目录（lsof；没有 lsof 的 Linux 读 /proc） */
function processCwd(pid: number): string | null {
  const line = run(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]).split("\n").find((l) => l.startsWith("n"));
  if (line) return line.slice(1);
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null; // 查不到就当不是（宁可不杀）
  }
}

/**
 * pid 还活着，而且确实是**这个**沙箱的 bridge：命令行是本仓库的 bridge.ts，工作目录是沙箱根目录。
 * 只比命令行不够——沙箱从主树起时，pid 复用后命中的可能恰好是生产 bridge（命令行一字不差）。
 */
function bridgeAlive(layout: SandboxLayout): number | null {
  let pid: number;
  try {
    pid = Number(readFileSync(layout.pidFile, "utf8").trim());
  } catch {
    return null; // 没有 pid 文件 = 没在跑
  }
  if (!Number.isInteger(pid) || pid <= 1) return null;
  if (!run(["ps", "-o", "command=", "-p", String(pid)]).includes(`${SRC_DIR}/bridge.ts`)) return null;
  const cwd = processCwd(pid);
  return cwd && canonicalPath(cwd) === canonicalPath(layout.root) ? pid : null;
}

function portFree(port: number): boolean {
  try {
    Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false; // 绑不上 = 有人在用
  }
}

async function waitReady(port: number, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const ok = await fetch(`http://127.0.0.1:${port}/stats`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
    if (ok) return true;
    await Bun.sleep(300);
  }
  return false;
}

/** up 之前的全部检查——都过了才建任何目录 */
function upProblems(o: Opts, layout: SandboxLayout): string[] {
  const out: string[] = [];
  if (existsSync(layout.root) && readdirSync(layout.root).length && markerProblem(layout)) out.push(`${layout.root} 已存在且不是沙箱目录，换一个 --root`);
  const prodHit = o.deny.dirs.find((d) => pathsOverlap(layout.root, d));
  if (prodHit) out.push(`沙箱根目录 ${layout.root} 与生产的 ${prodHit} 重叠`);
  const env = envFor(o, layout);
  out.push(...sandboxDirProblems({
    env, stateDir: layout.stateDir, runtimeDir: layout.runtimeDir, defaultStateDir: stateDirIn(homedir()), defaultRuntimeDir: DEFAULT_RUNTIME_DIR,
  }));
  if (o.staticDir) {
    const p = sandboxStaticDirProblem(o.staticDir, o.deny.dirs);
    if (p) out.push(p);
  }
  if (bridgeAlive(layout)) out.push(`沙箱已经在跑（${layout.root}）；先 down`);
  if (!portFree(o.port)) out.push(`端口 ${o.port} 已被占用；换一个 --port`);
  return out;
}

async function cmdUp(o: Opts, layout: SandboxLayout): Promise<void> {
  const problems = upProblems(o, layout);
  if (problems.length) fail(problems.join("\n   "));
  for (const d of [layout.root, layout.stateDir, layout.runtimeDir, layout.masterDir, layout.workDir, layout.zdotDir]) mkdirSync(d, { recursive: true });
  const marker = { root: canonicalPath(layout.root), port: o.port, repo: resolve(SRC_DIR, ".."), createdAt: new Date().toISOString() };
  writeFileSync(join(layout.root, MARKER), JSON.stringify(marker) + "\n");
  for (const [f, body] of Object.entries(zdotdirFiles(layout.historyFile))) writeFileSync(join(layout.zdotDir, f), body);
  if (runInSandbox(o, layout, [import.meta.path, INNER, "ensure-tmux", ...passOpts(o)]) !== 0) fail("沙箱 tmux 起不来（看上面的错误）");

  const log = openSync(layout.logFile, "a");
  const proc = Bun.spawn([process.execPath, "--no-env-file", `${SRC_DIR}/bridge.ts`], {
    cwd: layout.root, env: envFor(o, layout), stdin: "ignore", stdout: log, stderr: log, detached: true,
  });
  closeSync(log);
  proc.unref();
  writeFileSync(layout.pidFile, `${proc.pid}\n`);
  if (!(await waitReady(o.port, 20_000))) fail(`bridge 20 秒内没起来，看日志：${layout.logFile}`);
  // 新建 agent 要能按目录归到某个 project：给沙箱工作目录建一个（已存在时 manager 报错，无害）
  runInSandbox(o, layout, [`${SRC_DIR}/manager.ts`, "project-add", "sandbox", "--dirs", layout.workDir, "--name", "Sandbox"], true);
  const self = `bun run sandbox${o.port === DEFAULT_PORT ? "" : ` --port ${o.port}`}`;
  console.log([
    `✅ 沙箱 bridge 已启动：http://127.0.0.1:${o.port}（pid ${proc.pid}，Web-only）`,
    `   根目录 ${layout.root}（状态 state/、tmux 与截图 run/、日志 bridge.log；agent 只能建在这下面）`,
    `   建 agent：${self} manager create sbx-a ${layout.workDir} "测试用"`,
    `   发 token：${self} manager token-add dev --agents '*' --force`,
    `   停掉：${self} down；连目录一起删：${self} clean`,
  ].join("\n"));
}

function passOpts(o: Opts): string[] {
  return ["--port", String(o.port), "--root", o.root, ...(o.staticDir ? ["--static", o.staticDir] : [])];
}

async function stopBridge(layout: SandboxLayout): Promise<void> {
  const pid = bridgeAlive(layout);
  if (pid) {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 50 && bridgeAlive(layout); i++) await Bun.sleep(100);
    if (bridgeAlive(layout)) process.kill(pid, "SIGKILL");
    console.log(`🛑 沙箱 bridge 已停（pid ${pid}）`);
  }
  rmSync(layout.pidFile, { force: true });
}

async function cmdDown(o: Opts, layout: SandboxLayout): Promise<void> {
  const bad = markerProblem(layout);
  if (bad) fail(bad);
  await stopBridge(layout);
  runInSandbox(o, layout, [import.meta.path, INNER, "kill-tmux", ...passOpts(o)]);
}

/** 删目录前的闸：标记文件存在且记的就是这个根、不是 home 或它的上级、不与生产目录重叠 */
function cleanRefusal(o: Opts, layout: SandboxLayout): string | null {
  const bad = markerProblem(layout);
  if (bad) return bad;
  const c = canonicalPath(layout.root);
  const home = canonicalPath(homedir());
  if (c === "/" || c === home || home.startsWith(`${c}/`)) return `${layout.root} 是 home 或它的上级`;
  const hit = o.deny.dirs.find((d) => pathsOverlap(c, d));
  return hit ? `${layout.root} 与生产的 ${hit} 重叠` : null;
}

async function cmdClean(o: Opts, layout: SandboxLayout): Promise<void> {
  const refusal = cleanRefusal(o, layout);
  if (refusal) fail(refusal);
  await cmdDown(o, layout);
  rmSync(layout.root, { recursive: true, force: true });
  console.log(`🧹 已删除 ${layout.root}`);
}

async function cmdStatus(o: Opts, layout: SandboxLayout): Promise<void> {
  const pid = bridgeAlive(layout);
  const ready = pid ? await waitReady(o.port, 1500) : false;
  console.log(`根目录 ${layout.root}${markerProblem(layout) ? "（不是沙箱目录）" : ""}`);
  console.log(`bridge ${pid ? `pid ${pid}，${ready ? "在响应" : "不响应"}` : "没在跑"}，端口 ${o.port}`);
  if (pid) runInSandbox(o, layout, [`${SRC_DIR}/manager.ts`, "list"]);
}

function cmdEnv(o: Opts, layout: SandboxLayout): void {
  for (const [k, v] of Object.entries(envFor(o, layout))) console.log(`export ${k}='${v.replace(/'/g, "'\\''")}'`);
}

/** 沙箱环境里执行的内部步骤：此时 lib/paths 已按沙箱目录求值，tmux 走沙箱 socket */
async function inner(op: string, layout: SandboxLayout): Promise<void> {
  if (process.env[SANDBOX_FLAG] !== "1") fail("内部命令只能由沙箱脚本在沙箱环境里调用");
  const { tmuxRaw, MASTER_SESSION, MASTER_WINDOW_NAME } = await import("../src/lib/tmux-helper.js");
  if (op === "ensure-tmux") {
    const has = await tmuxRaw(["list-sessions", "-F", "#{session_name}"]);
    if (!has.split("\n").includes(MASTER_SESSION)) {
      await tmuxRaw(["new-session", "-d", "-s", MASTER_SESSION, "-n", MASTER_WINDOW_NAME, "-c", layout.masterDir]);
    }
    return;
  }
  if (op === "kill-tmux") {
    await tmuxRaw(["kill-server"]);
    console.log("🛑 沙箱 tmux 已关（沙箱 agent 随之退出）");
    return;
  }
  fail(`未知内部命令 ${op}`);
}

async function main(): Promise<void> {
  const [cmd = "", ...argv] = process.argv.slice(2);
  const o = parseOpts(argv);
  const layout = sandboxLayout(o.root);
  switch (cmd) {
    case "up": return cmdUp(o, layout);
    case "down": return cmdDown(o, layout);
    case "clean": return cmdClean(o, layout);
    case "status": return cmdStatus(o, layout);
    case "env": return cmdEnv(o, layout);
    case "manager": {
      const refusal = sandboxManagerRefusal(o.rest);
      if (refusal) fail(refusal);
      process.exit(runInSandbox(o, layout, [`${SRC_DIR}/manager.ts`, ...o.rest]));
    }
    case INNER: return inner(o.rest[0] ?? "", layout);
    default:
      console.log("用法：bun run sandbox up|status|down|clean|env|manager <子命令…> [--port N] [--root DIR] [--static DIR]");
      process.exit(cmd ? 1 : 0);
  }
}

await main();
