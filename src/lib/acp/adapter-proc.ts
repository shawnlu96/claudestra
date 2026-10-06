/**
 * 起 ACP agent 子进程（codex-acp，或沙箱 / 单测里的 stub）并把它的 stdio 接成 RpcWire。
 * - 起哪个：沙箱里固定是本仓的 stub，外部覆盖一律不认（stub.ts；owner 定的：不碰真 Codex 登录和 ~/.codex）；
 *   沙箱外 CLAUDESTRA_ACP_AGENT（JSON 字符串数组）优先（单测 / 手工排查用），
 *   否则是 `manager acp-install` 装好的 codex-acp 入口，用我们自己的 bun 跑，入口被改过就拒起（install.ts 校验哈希）。
 * - 环境：CODEX_PATH 锁本机的 codex；INITIAL_AGENT_MODE=agent-full-access（= tmux 下的 bypassPermissions）；
 *   CODEX_CONFIG 把 claudestra 的 channel-server 以 mcp_servers.<MCP_NAME>.* 深合并进去（同名 server 走 ACP 的 mcpServers
 *   会被适配器静默丢掉，config.toml 里就有 claudestra），它的 BRIDGE_URL 指到宿主的回环工具代理（带 token）。
 *   TMUX / TMUX_PANE 不给：channel-server 拿到它们会自己去标窗口就绪、往窗口里打字，acp 下这两件事都归宿主。
 * - 出借 worker（clean）：照样挂 channel-server，但设 lend 档（lib/lend-mcp-profile.ts，只有派单工具 + whoami），bun 不读 clone 里的
 *   .env* / bunfig.toml（channel-server 在外来 clone 里起）；代理在 clean 下也只转这几样（tool-proxy.ts），bridge 再按单核（bridge/lend-tools.ts）。
 * tests/acp-adapter-proc.test.ts。
 */
import type { Subprocess } from "bun";
import { mkdirSync } from "node:fs";
import { CODEX_MCP_ENV_VARS } from "../codex-launch.js";
import { isSandbox, SANDBOX_ROOT_ENV } from "../sandbox.js";
import { LEND_PROFILE, MCP_PROFILE_ENV } from "../lend-mcp-profile.js";
import { BUN_NO_AUTOLOAD, LEND_WORKER_MARK, pickWorkerEnv, workerPrivateDirs } from "../runtimes/clean-env.js";
import { codexAcpInstalled } from "./install.js";
import { redactSecrets } from "../redact-secrets.js";
import type { RpcWire } from "./rpc.js";
import { ACP_AGENT_ENV, isRepoStub, repoStubPath, sandboxAcpHome } from "./stub.js";

/** 给 channel-server 的环境白名单：去掉只有 tmux 模式才用得上的（窗口就绪 / 打字投递 / 重启前言） */
const ACP_MCP_ENV_VARS = CODEX_MCP_ENV_VARS.filter((k) => k !== "TMUX" && k !== "TMUX_PANE" && k !== "CLAUDESTRA_CODEX_PREAMBLE");
/** 出借 worker 的 channel-server 另带档位变量（丢了也不怕：channel-server 按 agent 名前缀照样开 lend 档） */
const LEND_MCP_ENV_VARS = [...ACP_MCP_ENV_VARS, MCP_PROFILE_ENV];

/** clean = 出借 worker：适配器在外来 clone 里起，bun 不自动加载 cwd 的 .env* 与 bunfig.toml（runtimes/clean-env.ts BUN_NO_AUTOLOAD），也不认手工覆盖 */
export function acpAgentCommand(env: Record<string, string | undefined>, bunBin: string, root?: string, clean = false): { cmd: string[]; stub: boolean } | { error: string } {
  const bun = [bunBin, ...(clean ? BUN_NO_AUTOLOAD : [])];
  if (isSandbox(env)) {
    const stub = repoStubPath();
    return stub ? { cmd: [...bun, stub], stub: true } : { error: "沙箱里找不到本仓的 scripts/acp-stub.ts（或它的真实路径不在本仓里），不起 ACP 适配器" };
  }
  const override = env[ACP_AGENT_ENV]?.trim();
  if (override && clean) return { error: `出借 worker 不认 ${ACP_AGENT_ENV} 手工覆盖（它的 argv 不受干净启动约束）` };
  if (override) {
    try {
      const cmd = JSON.parse(override);
      if (Array.isArray(cmd) && cmd.length && cmd.every((x) => typeof x === "string" && x)) return { cmd, stub: isRepoStub(cmd) };
    } catch {
      /* 不是 JSON：落到下面报错，不猜着拆空格 */
    }
    return { error: `${ACP_AGENT_ENV} 要是非空的 JSON 字符串数组（比如 ["bun","scripts/acp-stub.ts"]），收到：${override.slice(0, 120)}` };
  }
  const installed = codexAcpInstalled(root);
  return installed.ok ? { cmd: [...bun, installed.path], stub: false } : { error: installed.hint };
}

export interface AdapterEnvSpec {
  base: Record<string, string | undefined>;
  bunBin: string;
  channelServer: string;
  mcpName: string;
  /** 本机 codex 的路径（CODEX_PATH）；stub 不需要 */
  codexPath?: string;
  logsDir: string;
  /** 有 = 宿主模式：channel-server 挂上、指向回环代理；没有 = create 的引导（不挂 claudestra，频道相关变量全清掉） */
  channel?: { channelId: string; proxyUrl: string; agentName: string; sessionId: string };
  developerInstructions?: string;
  /** 出借 worker（runtimes/clean-env.ts）：只从 base 里拿白名单变量；channel-server 挂 lend 档（只有派单工具 + whoami） */
  clean?: boolean;
  /** clean 必填：worker 专属的临时目录，状态 / 运行目录指到它下面（workerPrivateDirs），由起它的进程负责删 */
  workerRoot?: string;
}

/** 宿主环境 → 适配器环境的公共底（两家共用）：拷一份，去掉 tmux / 频道 / bridge 变量；干净模式只拿白名单 */
export function hostEnvBase(s: AdapterEnvSpec): Record<string, string> {
  // 宿主的生产状态目录不往下传：codex / pi 的 shell 继承这份环境（clean-env.ts workerPrivateDirs）
  if (s.clean && !s.workerRoot) throw new Error("出借 worker 的适配器环境缺专属临时目录（workerRoot）");
  const env: Record<string, string> = s.clean ? { ...pickWorkerEnv(s.base), ...workerPrivateDirs(s.workerRoot!), [LEND_WORKER_MARK]: "1" } : {};
  if (!s.clean) for (const [k, v] of Object.entries(s.base)) if (typeof v === "string") env[k] = v;
  // 干净模式的 BRIDGE_* 只可能是 pickWorkerEnv 在沙箱里放进来的（宿主的 bridge 地址，不带 token）：删了 worker 里的 manager 在沙箱里一加载就被拒
  const drop = ["TMUX", "TMUX_PANE", "CLAUDESTRA_CODEX_PREAMBLE", "DISCORD_CHANNEL_ID", ...(s.clean ? [] : ["BRIDGE_URL", "BRIDGE_PORT"]), ACP_AGENT_ENV];
  for (const k of drop) delete env[k];
  return env;
}

/** channel-server 要的频道变量（BRIDGE_URL 是宿主回环代理的地址，带 token） */
export function channelServerEnv(c: NonNullable<AdapterEnvSpec["channel"]>, mcpName: string, runtime: string): Record<string, string> {
  return { DISCORD_CHANNEL_ID: c.channelId, BRIDGE_URL: c.proxyUrl, CLAUDESTRA_AGENT: c.agentName, CLAUDESTRA_RUNTIME: runtime, CLAUDESTRA_SESSION_ID: c.sessionId, MCP_NAME: mcpName };
}

/** Codex：channel-server 以 CODEX_CONFIG 的 mcp_servers 交给 codex-acp，它按 env_vars 白名单从适配器环境里取频道变量 */
export function adapterEnv(s: AdapterEnvSpec): Record<string, string> {
  const env = hostEnvBase(s);
  const config: Record<string, unknown> = { check_for_update_on_startup: false };
  if (s.developerInstructions) config.developer_instructions = s.developerInstructions;
  if (s.channel) {
    const args = s.clean ? [...BUN_NO_AUTOLOAD, s.channelServer] : [s.channelServer];
    config.mcp_servers = { [s.mcpName]: { command: s.bunBin, args, env_vars: s.clean ? LEND_MCP_ENV_VARS : ACP_MCP_ENV_VARS } };
    Object.assign(env, channelServerEnv(s.channel, s.mcpName, "codex"), s.clean ? { [MCP_PROFILE_ENV]: LEND_PROFILE } : {});
    // 沙箱 clean 带进来的宿主 BRIDGE_PORT 和代理地址的端口对不上，worker 里任何 bun 进程过沙箱总闸都会被拒（lib/sandbox.ts）
    if (s.clean) delete env.BRIDGE_PORT;
  }
  if (s.codexPath) env.CODEX_PATH = s.codexPath;
  if (isSandbox(s.base)) Object.assign(env, sandboxAcpHome(s.base[SANDBOX_ROOT_ENV])); // 沙箱：适配器和它起的 channel-server 碰不到 owner 的家目录
  env.INITIAL_AGENT_MODE = "agent-full-access";
  env.APP_SERVER_LOGS = s.logsDir;
  env.CODEX_CONFIG = JSON.stringify(config);
  return env;
}

export interface AdapterProc {
  wire: RpcWire;
  /** 结束子进程：先关 stdin（codex-acp 会在 2s 内带走 app-server），再 SIGTERM */
  stop(): void;
  exited: Promise<number>;
}

/**
 * 起子进程；stderr 按行加 label 前缀交给 log（适配器自己的详细日志另在 APP_SERVER_LOGS）。Pi 适配器也用它起 pi。
 * detached：子进程自成一个进程组（setsid），收尾时可以按组连孙进程一起清掉；不传就和原来一样留在本进程组里。
 */
export function spawnAdapter(
  cmd: string[],
  env: Record<string, string>,
  cwd: string,
  log: (msg: string) => void,
  label = "codex-acp",
  opts: { detached?: boolean } = {},
): AdapterProc {
  if (isSandbox(env) && env.HOME) mkdirSync(env.HOME, { recursive: true }); // 沙箱里隔离出来的 HOME（adapterEnv）第一次用时还不存在
  const detached = opts.detached ? { detached: true } : {};
  const proc: Subprocess<"pipe", "pipe", "pipe"> = Bun.spawn(cmd, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe", ...detached });
  const closeCbs: ((why: string) => void)[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>, cb: (c: Uint8Array) => void) => {
    for await (const chunk of stream) cb(chunk);
  };
  let dataCb: (c: Uint8Array) => void = () => {};
  void pump(proc.stdout, (c) => dataCb(c)).catch((e) => log(`适配器 stdout 读取出错：${e}`));
  const dec = new TextDecoder();
  void pump(proc.stderr, (c) => {
    for (const line of dec.decode(c).split("\n")) if (line.trim()) log(`[${label}] ${redactSecrets(line).slice(0, 300)}`); // 先打码再截
  }).catch((e) => log(`适配器 stderr 读取出错：${e}`));
  void proc.exited.then((code) => closeCbs.splice(0).forEach((cb) => cb(`exit ${code}`)));
  const stop = () => {
    try {
      proc.stdin.end();
    } catch {
      /* 已经关了 / 进程已退：接着发信号即可 */
    }
    setTimeout(() => proc.exitCode === null && proc.kill("SIGTERM"), 3_000).unref?.();
  };
  return {
    wire: {
      write: (line) => void proc.stdin.write(line),
      onData: (cb) => (dataCb = cb),
      onClose: (cb) => void closeCbs.push(cb),
      close: (why) => (log(`断开适配器：${why}`), stop()),
    },
    stop,
    exited: proc.exited,
  };
}
