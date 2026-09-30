/**
 * 沙箱的启动侧（scripts/sandbox.ts 与 claude-launch 用）：目录布局、从零构建的环境、生产配置的拒绝清单、
 * manager 白名单、沙箱 agent 的 MCP 参数。运行期闸门在 lib/sandbox.ts。纯函数，tests/sandbox.test.ts。
 */
import { join } from "path";
import { settingsLaunchArgs } from "./agent-settings.js";
import { sandboxAcpHome } from "./acp/stub.js";
import { isLab } from "./sandbox-lab.js";
import { SANDBOX_DENY_DIRS_ENV, SANDBOX_DENY_PORTS_ENV, SANDBOX_FLAG, SANDBOX_ROOT_ENV, sandboxPiAgentDir } from "./sandbox.js";

type Env = Record<string, string | undefined>;

/**
 * 从调用者环境里只拿这些键。**不继承其余一切**：执行者 agent 自己的环境带着 BRIDGE_URL=生产端口、
 * DISCORD_CHANNEL_ID、MCP_NAME 等，继承下去沙箱 agent 就会连到生产 bridge。
 */
const INHERITED_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR",
  // 代理配置只影响「怎么出网」，不带身份；测试靠它把漏网的出站请求引到计数替身上。lab 模式不继承（scripts/sandbox.ts 的 envFor）
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  // CLAUDESTRA_ACP_AGENT 刻意不继承：沙箱里 acp 固定起本仓的 stub（lib/acp/stub.ts），外部 argv 一律不认
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

/** 生产那边要避开的端口与目录（默认值之外，生产 .env / launchd plist 里改过的） */
export interface ProductionDeny {
  ports: number[];
  dirs: string[];
}

const PROD_PORT_KEYS = ["BRIDGE_PORT", "PEER_INGRESS_PORT", "WEB_PORT", "BRIDGE_LEGACY_WEB_PORT"];
const PROD_DIR_KEYS = ["CLAUDESTRA_STATE_DIR", "CLAUDESTRA_RUNTIME_DIR", "MASTER_DIR", "BRIDGE_STATIC_DIR"];

/** 把几份生产配置（plist 的 EnvironmentVariables、生产仓库 .env …）合成拒绝清单，外加默认值 */
export function productionDeny(sources: Env[], defaults: { port: number; dirs: string[] }): ProductionDeny {
  const ports = new Set<number>([defaults.port]);
  const dirs = new Set<string>(defaults.dirs);
  for (const src of sources) {
    for (const k of PROD_PORT_KEYS) {
      const n = Number(src[k]);
      if (Number.isInteger(n) && n > 0 && n < 65536) ports.add(n);
    }
    for (const k of PROD_DIR_KEYS) if ((src[k] || "").trim().startsWith("/")) dirs.add(src[k]!.trim());
  }
  return { ports: [...ports], dirs: [...dirs] };
}

export function sandboxEnv(
  base: Env,
  opts: { layout: SandboxLayout; port: number; deny: ProductionDeny; staticDir?: string },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of INHERITED_KEYS) {
    const v = base[k];
    if (v) out[k] = v;
  }
  Object.assign(out, {
    [SANDBOX_FLAG]: "1",
    [SANDBOX_ROOT_ENV]: opts.layout.root,
    [SANDBOX_DENY_PORTS_ENV]: opts.deny.ports.join(","),
    [SANDBOX_DENY_DIRS_ENV]: opts.deny.dirs.join(":"),
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
    // statusLine 脚本跑的 python3：macOS 自带的那个把字节码缓存写进 ~/Library/Caches/com.apple.python
    PYTHONDONTWRITEBYTECODE: "1",
    // manager / bridge 定位 Codex 会话与凭据按 CODEX_HOME，不设就回落宿主 ~/.codex；与 ACP 链同一个值（沙箱根非绝对路径时抛）
    CODEX_HOME: sandboxAcpHome(opts.layout.root).CODEX_HOME,
    // spike（Pi 直连 rpc）：Pi 的会话 / 设置目录，bridge 读历史、manager 起 Pi 都按它（lib/pi-session.ts piAgentDir）
    PI_CODING_AGENT_DIR: sandboxPiAgentDir(opts.layout.root),
  });
  if (opts.staticDir) out.BRIDGE_STATIC_DIR = opts.staticDir;
  return out;
}

/**
 * 沙箱 agent 的额外启动参数，都指向**本 checkout** 的代码，而不是全局配置里登记的主树那份：
 * - channel-server：全局 `claude mcp add` 注册的是主树的，测不到当前分支；`--strict-mcp-config` 顺带
 *   不加载用户其它 MCP（mem0 之类会写真实数据）。
 * - statusLine：全局 settings.json 指向主树的 statusline 脚本，主树没更新到认 CLAUDESTRA_STATE_DIR 的版本时，
 *   沙箱 agent 每刷新一次状态栏就写一次生产的 usage-cache.json。`--settings` 的优先级高于用户设置，覆盖掉它。
 *   agent 自己的设置（lib/agent-settings.ts）并进同一份：两个 --settings 怎么合并 CC 没背书；超长同样落快照（settingsLaunchArgs）。
 */
export function sandboxLaunchArgs(mcpName: string, bunPath: string, srcDir: string, agentSettings: Record<string, unknown> = {}, agent?: string, withMcpConfig = true): string[] {
  const cfg = { mcpServers: { [mcpName]: channelServerEntry(bunPath, srcDir, true) } };
  const settings = { ...agentSettings, statusLine: { type: "command", command: join(srcDir, "..", "scripts", "statusline-usage.sh") } };
  // withMcpConfig=false：调用方自己带一份含启动凭据的 --mcp-config（lib/claude-launch.ts），两份同名配置谁生效 CC 没背书
  return [...(withMcpConfig ? ["--mcp-config", JSON.stringify(cfg)] : []), "--strict-mcp-config", ...settingsLaunchArgs(settings, agent)];
}

/**
 * channel-server 在 MCP 配置里的那一项。沙箱跑本 checkout（--no-env-file：不读仓库 .env）；生产与 setup 的
 * `claude mcp add … -- bun run <仓库>/src/channel-server.ts` 同一条命令。env 只给这个服务进程（启动凭据走这里）。
 */
export function channelServerEntry(bunPath: string, srcDir: string, sandbox: boolean, env?: Record<string, string>) {
  const script = join(srcDir, "channel-server.ts");
  return { command: bunPath, args: sandbox ? ["--no-env-file", script] : ["run", script], ...(env ? { env } : {}) };
}

/**
 * 沙箱里 manager 允许跑的子命令。manager.ts 分发前自己查（isSandbox 时），scripts/sandbox.ts 再查一遍：
 * 带着沙箱环境直接 `bun src/manager.ts …`（`eval "$(bun run sandbox env)"`、沙箱 agent 自己的 Bash）也过不去。
 * 名单外的会碰 launchd（install-cli / update）、全局 ~/.claude（install-hooks / install-skills）、生产会话
 * （takeover / resume / adopt）或外部网络（peer-*）。后半截是沙箱 bridge 自己经 runManager 调的。
 */
const SANDBOX_MANAGER_COMMANDS = new Set([
  "create", "kill", "remove", "list", "restart", "archive", "token-add", "token-list", "token-revoke",
  "project-add", "project-list", "project-assign", "project-edit", "project-remove", "cron-list", "tmux-capture",
  "project-migrate", "worker-kind-migrate", "sessions", "set-session", "label", "cron-add", "cron-edit", "cron-remove", "cron-toggle", "cron-history",
  "tmux-send-keys", "team-link", // team-link 只改沙箱 registry 的 parent / task（manager/team.ts），同 label
  "rename", "repair", "fleet", // 只动沙箱 registry / tmux / bridge（manager/agent-rename.ts、manager/repair.ts；fleet 只连沙箱 bridge 的 ws）；doctor 读生产 launchd，仍不开放
  "quota-wall", // 额度闸 status|clear：只读写沙箱状态目录下的 quota-wall.json / 请求文件（manager/quota-wall.ts）
  "ledger", // 台账只写沙箱状态目录里的 ledger.sqlite 与沙箱 registry；班子的事件路由、沙箱 bridge 经 runManager 跑的定时巡检都要在沙箱里实测
  "team", // 班子提案只写沙箱状态目录的 team-proposals.json，按钮经沙箱 bridge 贴出
  "skill-toggle", // 只写沙箱状态目录下的 agent-settings（lib/agent-settings.ts），技能目录只读
  "transport", // T60：切 transport 只写沙箱 registry、重启沙箱窗口；acp 那头在沙箱里只能是 stub（assertSandboxRuntime）
  "migrate", // T60：只改沙箱 registry，重启的 Codex 在沙箱里仍固定走 stub
]);

/**
 * lab 模式（lib/sandbox-lab.ts）另开的：新版邀请流程、peer 管理、给 agent 开 external（peer scope 只收 external agent）。
 * peer 落盘由 lib/peers.ts 按 lab 闸再查（只认同一 lab 目录下的沙箱实例），出站由闸门只放行 lab 端口。
 * 老三步握手（peer-http-invite / join / accept）、peer-http-tidy 不开：lab 用不上，少一条路少一处要审。
 */
const LAB_MANAGER_COMMANDS = new Set([
  "peer-invite-new", "peer-join-auto", "peer-invite-redeem", "peer-invite-list", "peer-invite-revoke", "peer-invite-inspect",
  "peer-http-list", "peer-http-test", "peer-http-scope", "peer-http-remove", "external",
]);

/** 返回拒绝原因；null = 可以跑。agent 目录与 runtime 另由 manager 的 create 入口按 lib/sandbox.ts 再查一遍。lab = 沙箱的 lab 模式 */
export function sandboxManagerRefusal(args: string[], lab = isLab(process.env)): string | null {
  const cmd = args[0] ?? "";
  if (!SANDBOX_MANAGER_COMMANDS.has(cmd) && !(lab && LAB_MANAGER_COMMANDS.has(cmd))) {
    const allowed = [...SANDBOX_MANAGER_COMMANDS, ...(lab ? LAB_MANAGER_COMMANDS : [])];
    return `沙箱里不开放 manager ${cmd || "（空）"}；可用：${allowed.join(" ")}`;
  }
  if (args.includes("--include-master")) return "沙箱没有大总管，不支持 --include-master";
  if (args.includes("--external") && !lab) return "沙箱不对外共享 agent（--external；lab 模式可以）";
  if (cmd === "transport" && args[2] === "tmux") return "沙箱 Codex 只许 ACP stub，不起真实 TUI";
  const rt = args.indexOf("--runtime");
  const acp = args[rt + 1] === "codex" && (args.indexOf("--transport") < 0 || args[args.indexOf("--transport") + 1] === "acp");
  const piRpc = args[rt + 1] === "pi"; // spike：Pi 在沙箱里固定走直连 rpc 宿主，会话目录钉在沙箱根（lib/pi-launch.ts）
  if (rt >= 0 && args[rt + 1] !== "claude-code" && !acp && !piRpc) return "沙箱只支持 Claude Code runtime（Pi / Codex 的启动链不经沙箱闸门；Codex 只许 --transport acp，适配器固定是 stub）";
  return null;
}
