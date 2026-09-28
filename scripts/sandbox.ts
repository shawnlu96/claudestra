#!/usr/bin/env bun
/**
 * 沙箱 bridge：一条命令在本机起一个与线上完全隔开的 Claudestra（docs/architecture/sandbox.md）。
 *
 *   bun run sandbox up [--port N] [--root DIR] [--static DIR]   起沙箱 bridge（Web-only，默认端口 23900）
 *   bun run sandbox manager <子命令…>                            在沙箱里跑 manager（create / kill / list / token-add …）
 *   bun run sandbox status | down | clean                        看状态 / 停掉 bridge 与沙箱 tmux / 停掉并删沙箱目录
 *   bun run sandbox env                                          打印沙箱环境（export 行，手动调试用）
 *
 * 所有沙箱侧的进程都由本脚本用**从零构建的环境**拉起（lib/sandbox.ts sandboxEnv），并带 `--no-env-file`：
 * 调用者自己的 BRIDGE_URL / DISCORD_CHANNEL_ID 和任何 .env 都进不去。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import {
  canonicalPath, sandboxEnv, sandboxLayout, sandboxManagerRefusal, sandboxStaticDirProblem, SANDBOX_FLAG, zdotdirFiles, type SandboxLayout,
} from "../src/lib/sandbox.js";
import { DEFAULT_BRIDGE_PORT } from "../src/lib/bridge-url.js";
import { SRC_DIR } from "../src/lib/repo-root.js";

const DEFAULT_PORT = 23900;
const MARKER = ".claudestra-sandbox";
const INNER = "__inner";

interface Opts {
  port: number;
  root: string;
  staticDir?: string;
  rest: string[];
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
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) fail(`--port 不合法：${port}`);
  if (port === DEFAULT_BRIDGE_PORT) fail(`${port} 是生产 bridge 的默认端口，沙箱不能用`);
  const staticProblem = staticDir ? sandboxStaticDirProblem(staticDir, join(homedir(), ".claude-orchestrator")) : null;
  if (staticProblem) fail(staticProblem);
  return { port, root: root || `/tmp/claudestra-sandbox-${port}`, staticDir, rest };
}

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function envFor(o: Opts, layout: SandboxLayout): Record<string, string> {
  return sandboxEnv(process.env, { layout, port: o.port, staticDir: o.staticDir });
}

/** 在沙箱环境里跑一个 bun 进程（继承 stdio），返回退出码 */
function runInSandbox(o: Opts, layout: SandboxLayout, args: string[], quiet = false): number {
  const r = Bun.spawnSync([process.execPath, "--no-env-file", ...args], {
    cwd: layout.root, env: envFor(o, layout), stdin: "inherit", stdout: quiet ? "pipe" : "inherit", stderr: quiet ? "pipe" : "inherit",
  });
  return r.exitCode ?? 1;
}

function readPid(layout: SandboxLayout): number | null {
  try {
    const pid = Number(readFileSync(layout.pidFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null; // 没有 pid 文件 = 没在跑
  }
}

/** pid 还活着且确实是这个沙箱的 bridge（防 pid 复用后误杀别的进程） */
function bridgeAlive(layout: SandboxLayout): number | null {
  const pid = readPid(layout);
  if (!pid) return null;
  const r = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
  return r.stdout.toString().includes(`${SRC_DIR}/bridge.ts`) ? pid : null;
}

function portFree(port: number): boolean {
  try {
    const s = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    s.stop(true);
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

async function cmdUp(o: Opts, layout: SandboxLayout): Promise<void> {
  if (bridgeAlive(layout)) fail(`沙箱已经在跑（${layout.root}）；先 down`);
  if (!portFree(o.port)) fail(`端口 ${o.port} 已被占用；换一个 --port`);
  for (const d of [layout.root, layout.stateDir, layout.runtimeDir, layout.masterDir, layout.workDir, layout.zdotDir]) mkdirSync(d, { recursive: true });
  for (const [f, body] of Object.entries(zdotdirFiles(layout.historyFile))) writeFileSync(join(layout.zdotDir, f), body);
  writeFileSync(join(layout.root, MARKER), JSON.stringify({ port: o.port, repo: resolve(SRC_DIR, ".."), createdAt: new Date().toISOString() }) + "\n");
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
    `   根目录 ${layout.root}（状态 state/、tmux 与截图 run/、日志 bridge.log）`,
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
  if (!existsSync(join(layout.root, MARKER))) fail(`${layout.root} 不是沙箱目录（没有 ${MARKER}）`);
  await stopBridge(layout);
  runInSandbox(o, layout, [import.meta.path, INNER, "kill-tmux", ...passOpts(o)]);
}

/** 删目录前三道闸：有标记文件、不是 home 或它的祖先、不与生产状态目录重叠 */
function cleanRefusal(root: string): string | null {
  if (!existsSync(join(root, MARKER))) return `${root} 没有 ${MARKER}，不是本脚本建的沙箱`;
  const c = canonicalPath(root);
  const home = canonicalPath(homedir());
  if (c === "/" || home.startsWith(`${c}/`) || c === home) return `${root} 是 home 或它的上级`;
  if (c.startsWith(canonicalPath(join(homedir(), ".claude-orchestrator")))) return `${root} 在生产状态目录里`;
  return null;
}

async function cmdClean(o: Opts, layout: SandboxLayout): Promise<void> {
  const refusal = cleanRefusal(layout.root);
  if (refusal) fail(refusal);
  await cmdDown(o, layout);
  rmSync(layout.root, { recursive: true, force: true });
  console.log(`🧹 已删除 ${layout.root}`);
}

async function cmdStatus(o: Opts, layout: SandboxLayout): Promise<void> {
  const pid = bridgeAlive(layout);
  const ready = pid ? await waitReady(o.port, 1500) : false;
  console.log(`根目录 ${layout.root}${existsSync(join(layout.root, MARKER)) ? "" : "（不存在）"}`);
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
