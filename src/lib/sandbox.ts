/**
 * 沙箱实例（开发 / 执行者实机测试用，docs/architecture/sandbox.md）：`CLAUDESTRA_SANDBOX=1` 的进程
 * 一律 fail-closed——目录、端口、外部身份任何一项会落到生产上，就直接抛错不启动。
 *
 * 不设这个开关时本模块什么都不做（所有导出的检查都以 isSandbox 为前提），生产行为逐字节不变。
 * 本文件只依赖 node: 模块：lib/paths.ts、lib/bridge-url.ts 都 import 它，反向 import 会成环。
 * 启动侧（环境构建、目录布局、manager 白名单）在 lib/sandbox-env.ts。
 */
import { existsSync, realpathSync, statSync } from "fs";
import { dirname, join, relative, resolve, isAbsolute, basename } from "path";
import {
  isLab, labConfigProblems, labOutboundPorts, labPeerUrlProblem, labPushEndpointProblem, labRelayUrlProblem, LAB_ROOT_ENV, readLabInstances,
} from "./sandbox-lab.js";

export const SANDBOX_FLAG = "CLAUDESTRA_SANDBOX";
/** 沙箱根目录：agent 只许建在它下面（scripts/sandbox.ts 设） */
export const SANDBOX_ROOT_ENV = "CLAUDESTRA_SANDBOX_ROOT";
/** 生产改过的端口 / 目录（scripts/sandbox.ts 从生产 .env 与 launchd plist 里读出来）；与默认值一起拒绝 */
export const SANDBOX_DENY_PORTS_ENV = "CLAUDESTRA_SANDBOX_DENY_PORTS";
export const SANDBOX_DENY_DIRS_ENV = "CLAUDESTRA_SANDBOX_DENY_DIRS";
/** 沙箱根目录里的标记文件（scripts/sandbox.ts 建）：生产侧靠它认出「这是沙箱的目录」 */
export const SANDBOX_MARKER = ".claudestra-sandbox";

type Env = Record<string, string | undefined>;

/** 抛这个错 = 沙箱配置会碰到生产，调用方不要 catch 掉继续跑 */
class SandboxViolation extends Error {
  constructor(problems: string[]) {
    super(`沙箱模式（${SANDBOX_FLAG}=1）拒绝启动：\n  - ${problems.join("\n  - ")}`);
    this.name = "SandboxViolation";
  }
}

/** 只认 1（开）与空 / 0（关）；写成 true / yes 之类直接报错——悄悄当成「关」就是带着沙箱意图跑生产 */
export function isSandbox(env: Env = process.env): boolean {
  const v = (env[SANDBOX_FLAG] || "").trim();
  if (v === "" || v === "0") return false;
  if (v === "1") return true;
  throw new SandboxViolation([`${SANDBOX_FLAG}=${v} 不认识：开沙箱写 1，关掉就不设`]);
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
    // Bun 的 realpath 对 unix socket 报 EOPNOTSUPP（tmux 的 master.sock 就是）：解析父目录再接上文件名。
    // 父目录也解析不了（刚被删 / 无权限）就按字面路径比，最多少认一次软链，不会放过相同的字面路径
    try {
      head = join(realpathSync(dirname(head)), basename(head));
    } catch {
      /* 见上 */
    }
  }
  return join(head, ...tail);
}

/** 两个路径（按真实路径）相同或互相包含 */
export function pathsOverlap(a: string, b: string): boolean {
  const [x, y] = [canonicalPath(a), canonicalPath(b)];
  const inside = (p: string, q: string) => {
    const r = relative(q, p);
    return r === "" || (!r.startsWith("..") && !isAbsolute(r));
  };
  return inside(x, y) || inside(y, x);
}

function denyPorts(env: Env): number[] {
  return (env[SANDBOX_DENY_PORTS_ENV] || "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
}

export function denyDirs(env: Env): string[] {
  return (env[SANDBOX_DENY_DIRS_ENV] || "").split(":").map((s) => s.trim()).filter(Boolean);
}

/**
 * `--static` 挂载的前端目录不能在生产状态目录里：线上 web 按版本发布在 ~/.claude-orchestrator/web-releases/，
 * 沙箱挂它虽然只读，但它会随生产发布 / 回滚原地切换，沙箱测到的就不是自己这份代码。挂 worktree 的 web/out。
 */
export function sandboxStaticDirProblem(staticDir: string, prodStateDirs: string | string[]): string | null {
  const hit = [prodStateDirs].flat().find((d) => pathsOverlap(staticDir, d));
  return hit ? `--static ${staticDir} 在生产状态目录 ${hit} 里（线上 web-releases）；改挂本 worktree 的 web/out 或临时目录` : null;
}

export interface DirCheck {
  env: Env;
  stateDir: string;
  runtimeDir: string;
  defaultStateDir: string;
  defaultRuntimeDir: string;
}

/**
 * 状态 / 运行目录必须显式 override，且与生产目录（默认值 + 生产改过的，见 SANDBOX_DENY_DIRS_ENV）互不包含
 * ——放在生产目录里面也算写生产。纯函数；lib/paths.ts 在模块加载时经 enforceSandboxProcess 调。
 */
export function sandboxDirProblems(c: DirCheck): string[] {
  const out: string[] = [];
  const prod = [c.defaultStateDir, c.defaultRuntimeDir, ...denyDirs(c.env)];
  const pairs: Array<[string, string, string]> = [
    ["CLAUDESTRA_STATE_DIR", c.stateDir, "状态目录"],
    ["CLAUDESTRA_RUNTIME_DIR", c.runtimeDir, "运行目录"],
  ];
  for (const [key, dir, label] of pairs) {
    if (!(c.env[key] || "").trim()) {
      out.push(`${key} 没设：${label}会落到生产目录`);
      continue;
    }
    const hit = prod.find((p) => pathsOverlap(dir, p));
    if (hit) out.push(`${label} ${dir} 与生产的 ${hit} 重叠`);
  }
  if (!out.length && pathsOverlap(c.stateDir, c.runtimeDir)) out.push(`状态目录与运行目录重叠（${c.stateDir} / ${c.runtimeDir}）`);
  return out;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function portOf(u: URL): number {
  if (u.port) return Number(u.port);
  return u.protocol === "https:" || u.protocol === "wss:" ? 443 : 80;
}

/** 管 launchd / 自动更新 / 定时起 agent 的入口：沙箱进程里一律不许跑（它们都会碰生产的机器级设施） */
const SANDBOX_FORBIDDEN_ENTRIES = ["launcher.ts", "cron.ts", "setup.ts"];

/**
 * 沙箱进程的总闸（lib/paths.ts 模块加载时调一次，所有 Claudestra 进程都经过它）：目录不安全就抛错；
 * BRIDGE_PORT 与 BRIDGE_URL 指向不同端口也抛错（出站白名单按 agent 实际连的 BRIDGE_URL 放行，
 * 两者不一致说明环境拼错了）；入口是 launcher / cron / setup 也抛错；都安全才装出站闸门。
 * bridgeUrl 是惰性的：非沙箱进程不求值。
 */
export function enforceSandboxProcess(c: DirCheck & { bridgeUrl: () => string; entry?: string }): void {
  if (!isSandbox(c.env)) return;
  const problems = sandboxDirProblems(c);
  const entry = basename(c.entry ?? "");
  if (SANDBOX_FORBIDDEN_ENTRIES.includes(entry)) problems.push(`${entry} 不能在沙箱里跑（它管 launchd / 自动更新 / 定时任务）`);
  const port = portOf(new URL(c.bridgeUrl()));
  const envPort = (c.env.BRIDGE_PORT || "").trim();
  if (envPort && Number(envPort) !== port) problems.push(`BRIDGE_PORT=${envPort} 与 BRIDGE_URL 的端口 ${port} 不一致`);
  try {
    problems.push(...labConfigProblems(c.env, port, denyPorts(c.env)));
  } catch (e) {
    problems.push((e as Error).message); // lab 开关写法不认识：同沙箱开关，报错不启动
  }
  if (problems.length) throw new SandboxViolation(problems);
  installOutboundGuard(new Set([port, ...labOutboundPorts(c.env)]));
}

/**
 * bridge 地址（BRIDGE_URL / BRIDGE_PORT 推出来的那个）在沙箱里必须是回环，且不是生产端口（默认值或
 * 生产 .env 改过的）。lib/bridge-url.ts 的 resolveBridgeUrl 调它：channel-server、hook、manager 都经
 * 那里取地址，所以漏传 BRIDGE_URL 的沙箱 agent 会报错，而不是悄悄连上生产 bridge。
 */
export function sandboxBridgeUrlProblem(url: string, defaultPort: number, extraDeny: number[] = []): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `bridge 地址 ${url} 不是合法 URL`;
  }
  if (!LOOPBACK_HOSTS.has(u.hostname)) return `bridge 地址 ${url} 不是本机回环`;
  if ([defaultPort, ...extraDeny].includes(portOf(u))) return `bridge 地址 ${url} 用的是生产端口`;
  return null;
}

export function enforceSandboxBridgeUrl(url: string, defaultPort: number, env: Env = process.env): void {
  if (!isSandbox(env)) return;
  const p = sandboxBridgeUrlProblem(url, defaultPort, denyPorts(env));
  if (p) throw new SandboxViolation([p]);
}

/** 这些键出现在沙箱 bridge 的环境里就拒绝启动：每一个都会让它以生产身份对外说话或多开端口 */
const SANDBOX_FORBIDDEN_ENV = [
  "DISCORD_BOT_TOKEN", "RELAY_URL", "PEER_INGRESS_PORT", "PEER_INGRESS_PUBLIC", "PEER_PUBLIC_URL",
  "BRIDGE_LEGACY_WEB_PORT", "BRIDGE_CONTROL_TOKEN", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_KEY_DIR",
] as const;

/** bridge 进程专属的环境检查（bridge/config.ts 加载时调）；非沙箱返回空数组 */
export function sandboxBridgeEnvProblems(defaultPort: number, env: Env = process.env): string[] {
  if (!isSandbox(env)) return [];
  const out: string[] = [];
  const port = Number(env.BRIDGE_PORT);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) out.push(`BRIDGE_PORT 没设或不合法：会回落到生产默认端口 ${defaultPort}`);
  else if ([defaultPort, ...denyPorts(env)].includes(port)) out.push(`BRIDGE_PORT=${port} 是生产端口`);
  for (const k of SANDBOX_FORBIDDEN_ENV) {
    const v = (env[k] || "").trim();
    if (!v || labAllowsEnv(k, v, port, env)) continue;
    out.push(`环境里有 ${k}（沙箱不连 Discord / 中继 / peer / 推送，也不多开端口；lab 模式只认 lab 中继与 lab 端口）`);
  }
  const bind = (env.BRIDGE_BIND || "127.0.0.1").trim();
  if (!LOOPBACK_HOSTS.has(bind)) out.push(`BRIDGE_BIND=${bind}：沙箱只许绑回环`);
  return out;
}

/** lab 模式下这两个键可以有，但只能指向 lab 自己：RELAY_URL = lab 中继，PEER_INGRESS_PORT = lab 端口之一（不是 bridge 端口） */
function labAllowsEnv(key: string, value: string, bridgePort: number, env: Env): boolean {
  if (!isLab(env)) return false;
  if (key === "RELAY_URL") return labRelayUrlProblem(value, env) === null;
  if (key === "PEER_INGRESS_PORT") return Number(value) !== bridgePort && labOutboundPorts(env).includes(Number(value));
  return false;
}

export function enforceSandboxBridgeEnv(defaultPort: number, env: Env = process.env): void {
  const problems = sandboxBridgeEnvProblems(defaultPort, env);
  if (problems.length) throw new SandboxViolation(problems);
}

/** 沙箱里关掉的功能：调用方拿到非 null 就跳过 / 拒绝，并把这句原因回给用户 */
export function sandboxDisabled(feature: string, env: Env = process.env): string | null {
  return isSandbox(env) ? `沙箱模式下「${feature}」已关闭（docs/architecture/sandbox.md）` : null;
}

/**
 * 沙箱里关掉、lab 模式（lib/sandbox-lab.ts）里打开的功能：中继链路、推送、peer。非沙箱与 lab 返回 null；
 * 打开之后每个出口还要各自过 lab 的闸（sandboxRelayUrlProblem / sandboxPeerUrlProblem / sandboxPushEndpointProblem）。
 */
export function sandboxDisabledOutsideLab(feature: string, env: Env = process.env): string | null {
  return isSandbox(env) && !isLab(env) ? `沙箱模式下「${feature}」已关闭（lab 模式才开，docs/architecture/sandbox.md）` : null;
}

/** 沙箱里要连的中继地址：非 lab 一律拒，lab 只认 lab 中继。非沙箱 null */
export function sandboxRelayUrlProblem(url: string, env: Env = process.env): string | null {
  if (!isSandbox(env)) return null;
  return isLab(env) ? labRelayUrlProblem(url, env) : "沙箱不连中继";
}

/**
 * 沙箱里要记 / 要连的 peer 地址：非 lab 一律拒，lab 只认同一 lab 目录下的沙箱实例（按它们的沙箱标记）；
 * 没有地址（只有入站的记录，不往外连）lab 里放行。非沙箱 null
 */
export function sandboxPeerUrlProblem(url: string | undefined, env: Env = process.env): string | null {
  if (!isSandbox(env)) return null;
  if (!isLab(env)) return "沙箱不建 peer";
  return url ? labPeerUrlProblem(url, readLabInstances((env[LAB_ROOT_ENV] || "").trim(), SANDBOX_MARKER)) : null;
}

/** 沙箱里收的推送订阅 endpoint：非 lab 一律拒，lab 只认假推送端点。非沙箱 null（生产照旧按 lib/push-endpoint.ts） */
export function sandboxPushEndpointProblem(endpoint: string, env: Env = process.env): string | null {
  if (!isSandbox(env)) return null;
  return isLab(env) ? labPushEndpointProblem(endpoint, env) : "沙箱不收推送订阅";
}

/**
 * 沙箱 agent 只许建在沙箱根目录下、且目录已存在。生产 agent 不会在那里，于是 bridge 按 cwd 认会话的几条路径
 * （clear 轮转、Stop 自愈、会话发现）不会把生产会话当成沙箱的，反之亦然。目录必须已存在：
 * `tmux new-window -c <不存在的目录>` 会静默回落到 $HOME，会话就写进了 ~/.claude/projects/-Users-<你>/。
 * `~user` 写法直接拒绝（manager 把 `~` 当前缀替换，`~foo` 会变成 /Users/<你>foo，与这里的判断对不上）。
 */
export function sandboxAgentDirProblem(dir: string, env: Env = process.env): string | null {
  if (!isSandbox(env)) return null;
  const root = (env[SANDBOX_ROOT_ENV] || "").trim();
  if (!root) return `沙箱没设 ${SANDBOX_ROOT_ENV}，不知道 agent 该建在哪（用 scripts/sandbox.ts 起沙箱）`;
  // 按原样判断，不做 trim：判断的必须就是 tmux -c 收到的那个字符串（规范化见 normalizeSandboxAgentDir）
  if (dir.startsWith("~") && dir !== "~" && !dir.startsWith("~/")) return `沙箱不认 ${dir} 这种 ~user 写法，写绝对路径`;
  const d = expandHome(dir, env);
  if (!isAbsolute(d)) return `沙箱 agent 的目录要写绝对路径（收到 ${dir}）`;
  const inside = relative(canonicalPath(root), canonicalPath(d));
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return `沙箱 agent 必须建在 ${root}/ 下面（收到 ${dir}）`;
  let isDir = false;
  try {
    isDir = statSync(d).isDirectory();
  } catch {
    /* 不存在：下面按「不是目录」报 */
  }
  return isDir ? null : `沙箱 agent 的目录 ${dir} 不存在或不是目录（tmux 会回落到 $HOME）`;
}

function expandHome(dir: string, env: Env): string {
  return dir === "~" || dir.startsWith("~/") ? (env.HOME || "") + dir.slice(1) : dir;
}

/** create 收到的目录在沙箱里先规范化（去首尾空白、展开 ~/），调用方后面一律用这个值，检查与实际使用的是同一个串 */
export function normalizeSandboxAgentDir(dir: string, env: Env = process.env): string {
  return isSandbox(env) ? expandHome(dir.trim(), env) : dir;
}

/**
 * 沙箱里 Codex 的根（CODEX_HOME）必须显式设在沙箱根下：没设时 Codex 会话 / auth.json 的定位回落宿主 ~/.codex，
 * 会扫到 owner 真实的 rollout、同 id 时把宿主正文拷进沙箱归档。沙箱环境由 sandbox-env.ts 设它（与 ACP 链同一个值）。
 * 非沙箱返回 null（生产照旧按 CODEX_HOME || ~/.codex）。调用入口在 lib/codex-home.ts、quota-credentials.ts。
 */
export function sandboxCodexHomeProblem(env: Env = process.env): string | null {
  if (!isSandbox(env)) return null;
  const root = (env[SANDBOX_ROOT_ENV] || "").trim();
  const home = (env.CODEX_HOME || "").trim();
  if (!root || !isAbsolute(root)) return `沙箱没设绝对路径的 ${SANDBOX_ROOT_ENV}，不知道 Codex 的根该在哪`;
  if (!home) return "沙箱里没设 CODEX_HOME：Codex 会话 / 凭据会回落到宿主 ~/.codex（用 scripts/sandbox.ts 起沙箱）";
  if (!isAbsolute(home)) return `沙箱里的 CODEX_HOME 要写绝对路径（收到 ${home}）`;
  const inside = relative(canonicalPath(root), canonicalPath(home));
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return `沙箱里的 CODEX_HOME=${home} 不在沙箱根 ${root}/ 下`;
  return null;
}

/** 定位 Codex 会话 / 凭据之前调：沙箱里 CODEX_HOME 不安全就抛，不回落宿主 */
export function assertSandboxCodexHome(env: Env = process.env): void {
  const p = sandboxCodexHomeProblem(env);
  if (p) throw new SandboxViolation([p]);
}

/** 生产侧：目录在某个沙箱根下就拒绝（sandbox clean 会连目录删掉）；沙箱里不管（沙箱 agent 本来就在那） */
export function refuseSandboxDirInProduction(dir: string, what: string, env: Env = process.env): void {
  if (isSandbox(env) || !dir || dir === "-") return;
  const root = sandboxRootOf(expandHome(dir, env));
  if (root) throw new Error(`${what}：${dir} 在沙箱 ${root} 里（sandbox clean 会删掉它），生产不在那里建`);
}

/** dir 所在的沙箱根（往上找 SANDBOX_MARKER）；不在任何沙箱里返回 null。生产侧用它拒绝接管沙箱的会话 */
export function sandboxRootOf(dir: string): string | null {
  for (let d = canonicalPath(dir); ; d = dirname(d)) {
    if (existsSync(join(d, SANDBOX_MARKER))) return d;
    if (dirname(d) === d) return null;
  }
}

/** 沙箱进程里不许做的动作：直接抛错（纵深防御——manager 的白名单之外，危险函数自己再拦一道） */
export function refuseInSandbox(what: string, env: Env = process.env): void {
  if (isSandbox(env)) throw new SandboxViolation([`沙箱里不许${what}`]);
}

/** Pi / Codex 的启动链不经本模块的闸门（Codex 给 MCP 的环境是白名单、还会加载用户全局 MCP）：沙箱里直接拒绝 */
/**
 * 沙箱只起 Claude Code；唯一例外是 T60 的 Codex over ACP：owner 定的，沙箱不碰真 Codex 登录和本机的 .codex 目录，适配器固定是本仓的
 * 协议 stub（lib/acp/stub.ts）。外部的 CLAUDESTRA_ACP_AGENT 是任意 argv，沙箱里带着它就拒——不让人以为它生效了。
 * tmux 版 Codex（buildCodexCommand 不带 transport）照旧拒。
 */
export function assertSandboxRuntime(runtime: string, env: Env = process.env, transport?: string): void {
  if (!isSandbox(env) || runtime === "claude-code") return;
  if (runtime === "codex" && transport === "acp") {
    if (!env.CLAUDESTRA_ACP_AGENT?.trim()) return;
    throw new SandboxViolation(["沙箱里不认 CLAUDESTRA_ACP_AGENT：acp 固定起本仓的 scripts/acp-stub.ts，把这个变量去掉再试"]);
  }
  throw new SandboxViolation([`沙箱只支持 Claude Code agent（收到 runtime=${runtime}${transport ? `、transport=${transport}` : ""}；Codex 只许 --transport acp，适配器固定是 stub）`]);
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
