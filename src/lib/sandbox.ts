/**
 * 沙箱实例（开发 / 执行者实机测试用，docs/architecture/sandbox.md）：`CLAUDESTRA_SANDBOX=1` 的进程
 * 一律 fail-closed——目录、端口、外部身份任何一项会落到生产上，就直接抛错不启动。
 *
 * 不设这个开关时本模块什么都不做（所有导出的检查都以 isSandbox 为前提），生产行为逐字节不变。
 * 本文件只依赖 node: 模块：lib/paths.ts、lib/bridge-url.ts 都 import 它，反向 import 会成环。
 */
import { existsSync, realpathSync } from "fs";
import { dirname, join, relative, resolve, isAbsolute, basename } from "path";

export const SANDBOX_FLAG = "CLAUDESTRA_SANDBOX";

type Env = Record<string, string | undefined>;

export function isSandbox(env: Env = process.env): boolean {
  return (env[SANDBOX_FLAG] || "").trim() === "1";
}

/** 抛这个错 = 沙箱配置会碰到生产，调用方不要 catch 掉继续跑 */
class SandboxViolation extends Error {
  constructor(problems: string[]) {
    super(`沙箱模式（${SANDBOX_FLAG}=1）拒绝启动：\n  - ${problems.join("\n  - ")}`);
    this.name = "SandboxViolation";
  }
}

/** 解析 /tmp → /private/tmp 这类软链：从最近一个存在的祖先 realpath，再接上不存在的尾巴 */
export function canonicalPath(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) break;
    tail.unshift(basename(head));
    head = up;
  }
  try {
    head = realpathSync(head);
  } catch {
    /* 祖先刚被删 / 无权限：按字面路径比，最多少认一次软链，不会放过相同的字面路径 */
  }
  return join(head, ...tail);
}

function overlaps(a: string, b: string): boolean {
  const inside = (x: string, y: string) => {
    const r = relative(y, x);
    return r === "" || (!r.startsWith("..") && !isAbsolute(r));
  };
  return inside(a, b) || inside(b, a);
}

/**
 * `--static` 挂载的前端目录不能在生产状态目录里：线上 web 按版本发布在 ~/.claude-orchestrator/web-releases/，
 * 沙箱挂它虽然只读，但它会随生产发布 / 回滚原地切换，沙箱测到的就不是自己这份代码。挂 worktree 的 web/out。
 */
export function sandboxStaticDirProblem(staticDir: string, prodStateDir: string): string | null {
  return overlaps(canonicalPath(staticDir), canonicalPath(prodStateDir))
    ? `--static ${staticDir} 在生产状态目录 ${prodStateDir} 里（线上 web-releases）；改挂本 worktree 的 web/out 或临时目录`
    : null;
}

export interface DirCheck {
  env: Env;
  stateDir: string;
  runtimeDir: string;
  defaultStateDir: string;
  defaultRuntimeDir: string;
}

/**
 * 状态 / 运行目录必须显式 override，且与生产默认目录互不包含（放在生产目录里面也算写生产）。
 * 纯函数；lib/paths.ts 在模块加载时调 enforceSandboxDirs。
 */
export function sandboxDirProblems(c: DirCheck): string[] {
  const out: string[] = [];
  const pairs: Array<[string, string, string, string]> = [
    ["CLAUDESTRA_STATE_DIR", c.stateDir, c.defaultStateDir, "状态目录"],
    ["CLAUDESTRA_RUNTIME_DIR", c.runtimeDir, c.defaultRuntimeDir, "运行目录"],
  ];
  for (const [key, dir, prod, label] of pairs) {
    if (!(c.env[key] || "").trim()) {
      out.push(`${key} 没设：${label}会落到生产的 ${prod}`);
      continue;
    }
    if (overlaps(canonicalPath(dir), canonicalPath(prod))) out.push(`${label} ${dir} 与生产的 ${prod} 重叠`);
  }
  if (!out.length && overlaps(canonicalPath(c.stateDir), canonicalPath(c.runtimeDir))) {
    out.push(`状态目录与运行目录重叠（${c.stateDir} / ${c.runtimeDir}）`);
  }
  return out;
}

/**
 * 沙箱进程的总闸（lib/paths.ts 模块加载时调一次，所有 Claudestra 进程都经过它）：目录不安全就抛错；
 * 安全就装上出站闸门，只放行本机回环上自己的 bridge 端口。
 */
export function enforceSandboxProcess(c: DirCheck & { bridgePort: number }): void {
  if (!isSandbox(c.env)) return;
  const problems = sandboxDirProblems(c);
  if (problems.length) throw new SandboxViolation(problems);
  installOutboundGuard(new Set([c.bridgePort]));
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function portOf(u: URL): number {
  if (u.port) return Number(u.port);
  return u.protocol === "https:" || u.protocol === "wss:" ? 443 : 80;
}

/**
 * bridge 地址（BRIDGE_URL / BRIDGE_PORT 推出来的那个）在沙箱里必须是回环且不是生产默认端口。
 * lib/bridge-url.ts 的 resolveBridgeUrl 调它：channel-server、hook、manager 都经那里取地址，
 * 所以漏传 BRIDGE_URL 的沙箱 agent 会报错，而不是悄悄连上生产 bridge。
 */
export function sandboxBridgeUrlProblem(url: string, defaultPort: number): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `bridge 地址 ${url} 不是合法 URL`;
  }
  if (!LOOPBACK_HOSTS.has(u.hostname)) return `bridge 地址 ${url} 不是本机回环`;
  if (portOf(u) === defaultPort) return `bridge 地址 ${url} 用的是生产默认端口 ${defaultPort}`;
  return null;
}

export function enforceSandboxBridgeUrl(url: string, defaultPort: number, env: Env = process.env): void {
  if (!isSandbox(env)) return;
  const p = sandboxBridgeUrlProblem(url, defaultPort);
  if (p) throw new SandboxViolation([p]);
}

/** 这些键出现在沙箱 bridge 的环境里就拒绝启动：每一个都会让它以生产身份对外说话或多开端口 */
const SANDBOX_FORBIDDEN_ENV = [
  "DISCORD_BOT_TOKEN",
  "RELAY_URL",
  "PEER_INGRESS_PORT",
  "PEER_INGRESS_PUBLIC",
  "PEER_PUBLIC_URL",
  "BRIDGE_LEGACY_WEB_PORT",
  "BRIDGE_CONTROL_TOKEN",
  "APNS_KEY_ID",
  "APNS_TEAM_ID",
  "APNS_KEY_DIR",
] as const;

/** bridge 进程专属的环境检查（bridge/config.ts 加载时调）；非沙箱返回空数组 */
export function sandboxBridgeEnvProblems(defaultPort: number, env: Env = process.env): string[] {
  if (!isSandbox(env)) return [];
  const out: string[] = [];
  const port = Number(env.BRIDGE_PORT);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) out.push(`BRIDGE_PORT 没设或不合法：会回落到生产默认端口 ${defaultPort}`);
  else if (port === defaultPort) out.push(`BRIDGE_PORT=${port} 是生产默认端口`);
  for (const k of SANDBOX_FORBIDDEN_ENV) if ((env[k] || "").trim()) out.push(`环境里有 ${k}（沙箱不连 Discord / 中继 / peer / 推送，也不多开端口）`);
  const bind = (env.BRIDGE_BIND || "127.0.0.1").trim();
  if (!LOOPBACK_HOSTS.has(bind)) out.push(`BRIDGE_BIND=${bind}：沙箱只许绑回环`);
  return out;
}

export function enforceSandboxBridgeEnv(defaultPort: number, env: Env = process.env): void {
  const problems = sandboxBridgeEnvProblems(defaultPort, env);
  if (problems.length) throw new SandboxViolation(problems);
}

/** 沙箱里关掉的功能：调用方拿到非 null 就跳过 / 拒绝，并把这句原因回给用户 */
export function sandboxDisabled(feature: string, env: Env = process.env): string | null {
  return isSandbox(env) ? `沙箱模式下「${feature}」已关闭（docs/architecture/sandbox.md）` : null;
}

// ── 出站闸门 ────────────────────────────────────────────────────────────────

/** 沙箱进程只许访问本机回环上的这些端口（自己的 bridge）；其余一律拒绝 */
export function outboundAllowed(target: string | URL, allowedPorts: ReadonlySet<number>): boolean {
  let u: URL;
  try {
    u = typeof target === "string" ? new URL(target) : target;
  } catch {
    return false;
  }
  if (u.protocol === "file:" || u.protocol === "data:" || u.protocol === "blob:") return true;
  if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) return false;
  return LOOPBACK_HOSTS.has(u.hostname) && allowedPorts.has(portOf(u));
}

export const OUTBOUND_BLOCKED_MARK = "🧱 sandbox-outbound-blocked";

function requestUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return String((input as { url?: string })?.url ?? "");
}

let guardInstalled = false;

/**
 * 包住 globalThis.fetch 与 WebSocket：非白名单目标直接拒绝并打一行带 OUTBOUND_BLOCKED_MARK 的日志
 * （tests/sandbox-isolation.test.ts 靠这行断言「没有功能试图出站」）。这是兜底：各功能在沙箱里
 * 本来就该自己关掉；discord.js / web-push / APNs 不走 globalThis.fetch，靠的是 bridge 的环境检查。
 */
function installOutboundGuard(allowedPorts: ReadonlySet<number>): void {
  if (guardInstalled) return;
  guardInstalled = true;
  const blocked = (what: string) => {
    console.error(`${OUTBOUND_BLOCKED_MARK} ${what}`);
    return new Error(`沙箱模式拒绝出站请求：${what}`);
  };
  const origFetch = globalThis.fetch;
  const guarded = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = requestUrl(input);
    if (!outboundAllowed(url, allowedPorts)) return Promise.reject(blocked(url));
    return origFetch(input, init);
  }) as typeof fetch;
  globalThis.fetch = Object.assign(guarded, origFetch);
  const OrigWs = globalThis.WebSocket;
  globalThis.WebSocket = class extends OrigWs {
    constructor(url: string | URL, protocols?: string | string[]) {
      if (!outboundAllowed(String(url), allowedPorts)) throw blocked(String(url));
      super(url, protocols);
    }
  } as typeof WebSocket;
}

// ── 沙箱启动环境（scripts/sandbox.ts 用）────────────────────────────────────

/**
 * 从调用者环境里只拿这些键。**不继承其余一切**：执行者 agent 自己的环境带着 BRIDGE_URL=生产端口、
 * DISCORD_CHANNEL_ID、MCP_NAME 等，继承下去沙箱 agent 就会连到生产 bridge。
 */
const INHERITED_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR",
  // 代理配置只影响「怎么出网」，不带身份；测试靠它把漏网的出站请求引到计数替身上
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
] as const;

export interface SandboxLayout {
  root: string;
  stateDir: string;
  runtimeDir: string;
  masterDir: string;
  workDir: string;
  logFile: string;
  pidFile: string;
  zdotDir: string;
  historyFile: string;
}

/** 沙箱根目录下的固定布局。根目录默认放 /tmp：unix socket 路径上限 104 字节，$TMPDIR 太长 */
export function sandboxLayout(root: string): SandboxLayout {
  return {
    root,
    stateDir: join(root, "state"),
    runtimeDir: join(root, "run"),
    masterDir: join(root, "master"),
    workDir: join(root, "work"),
    logFile: join(root, "bridge.log"),
    pidFile: join(root, "bridge.pid"),
    zdotDir: join(root, "zdotdir"),
    historyFile: join(root, "shell_history"),
  };
}

/**
 * ZDOTDIR 转发壳：照常加载用户自己的 ~/.zshenv / .zprofile / .zshrc / .zlogin（PATH、nvm 等 claude 启动要用），
 * 之后把 HISTFILE 钉回沙箱。否则 manager 往沙箱窗口里键入的启动命令会进用户真实的 ~/.zsh_history。
 */
export function zdotdirFiles(historyFile: string): Record<string, string> {
  const fwd = (f: string) => `[ -f "$HOME/${f}" ] && source "$HOME/${f}"\n`;
  const pin = `HISTFILE=${JSON.stringify(historyFile)}\n`;
  return { ".zshenv": fwd(".zshenv"), ".zprofile": fwd(".zprofile"), ".zshrc": fwd(".zshrc") + pin, ".zlogin": fwd(".zlogin") + pin };
}

export function sandboxEnv(
  base: Env,
  opts: { layout: SandboxLayout; port: number; staticDir?: string; extra?: Env },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of INHERITED_KEYS) {
    const v = base[k];
    if (v) out[k] = v;
  }
  Object.assign(out, {
    [SANDBOX_FLAG]: "1",
    CLAUDESTRA_STATE_DIR: opts.layout.stateDir,
    CLAUDESTRA_RUNTIME_DIR: opts.layout.runtimeDir,
    MASTER_DIR: opts.layout.masterDir,
    BRIDGE_PORT: String(opts.port),
    BRIDGE_URL: `ws://localhost:${opts.port}`,
    BRIDGE_BIND: "127.0.0.1",
    // 沙箱 tmux 里的交互 shell 与 bun 的转译缓存默认写 home：挪进沙箱根目录。zsh 走 ZDOTDIR 转发壳
    // （macOS /etc/zshrc 会无条件改写 HISTFILE，只设 env 不够），bash 认 HISTFILE
    HISTFILE: opts.layout.historyFile,
    ZDOTDIR: opts.layout.zdotDir,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(opts.layout.root, "bun-cache"),
  });
  if (opts.staticDir) out.BRIDGE_STATIC_DIR = opts.staticDir;
  for (const [k, v] of Object.entries(opts.extra ?? {})) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * 沙箱 agent 的 MCP 参数：channel-server 用**本仓库**的（全局 `claude mcp add` 注册的是主树那份，
 * 测不到当前分支的改动），`--strict-mcp-config` 顺带不加载用户其它 MCP（mem0 之类会写真实数据）。
 */
export function sandboxMcpArgs(mcpName: string, bunPath: string, channelServerPath: string): string[] {
  const cfg = { mcpServers: { [mcpName]: { command: bunPath, args: ["--no-env-file", channelServerPath] } } };
  return ["--mcp-config", JSON.stringify(cfg), "--strict-mcp-config"];
}

/** 沙箱里允许经 `scripts/sandbox.ts manager` 调的子命令（其余会碰 launchd / 生产会话 / 外部网络） */
const SANDBOX_MANAGER_COMMANDS = new Set([
  "create", "kill", "remove", "list", "restart", "archive", "token-add", "token-list", "token-revoke",
  "project-add", "project-list", "project-assign", "project-edit", "cron-list", "tmux-capture",
]);

/** 返回拒绝原因；null = 可以跑 */
export function sandboxManagerRefusal(args: string[]): string | null {
  const cmd = args[0] ?? "";
  if (!SANDBOX_MANAGER_COMMANDS.has(cmd)) {
    return `沙箱里不开放 manager ${cmd || "（空）"}；可用：${[...SANDBOX_MANAGER_COMMANDS].join(" ")}`;
  }
  if (args.includes("--include-master")) return "沙箱没有大总管，不支持 --include-master";
  if (args.includes("--external")) return "沙箱不对外共享 agent（--external）";
  const rt = args.indexOf("--runtime");
  if (rt >= 0 && args[rt + 1] !== "claude-code") return "沙箱只支持 Claude Code runtime（Pi / Codex 的启动链不经本模块的闸门）";
  return null;
}
