/**
 * 起 ACP agent 子进程（codex-acp，或沙箱 / 单测里的 stub）并把它的 stdio 接成 RpcWire。
 * - 起哪个：沙箱里固定是本仓的 stub，外部覆盖一律不认（stub.ts；owner 定的：不碰真 Codex 登录和 ~/.codex）；
 *   沙箱外 CLAUDESTRA_ACP_AGENT（JSON 字符串数组）优先（单测 / 手工排查用），
 *   否则是 `manager acp-install` 装好的 codex-acp 入口，用我们自己的 bun 跑，入口被改过就拒起（install.ts 校验哈希）。
 * - 环境：CODEX_PATH 锁本机的 codex；INITIAL_AGENT_MODE=agent-full-access（= tmux 下的 bypassPermissions）；
 *   CODEX_CONFIG 把 claudestra 的 channel-server 以 mcp_servers.<MCP_NAME>.* 深合并进去（同名 server 走 ACP 的 mcpServers
 *   会被适配器静默丢掉，config.toml 里就有 claudestra），它的 BRIDGE_URL 指到宿主的回环工具代理（带 token）。
 *   TMUX / TMUX_PANE 不给：channel-server 拿到它们会自己去标窗口就绪、往窗口里打字，acp 下这两件事都归宿主。
 * tests/acp-adapter-proc.test.ts。
 */
import type { Subprocess } from "bun";
import { mkdirSync } from "node:fs";
import { CODEX_MCP_ENV_VARS } from "../codex-launch.js";
import { isSandbox, SANDBOX_ROOT_ENV } from "../sandbox.js";
import { codexAcpInstalled } from "./install.js";
import type { RpcWire } from "./rpc.js";
import { ACP_AGENT_ENV, isRepoStub, repoStubPath, sandboxAcpHome } from "./stub.js";

/** 给 channel-server 的环境白名单：去掉只有 tmux 模式才用得上的（窗口就绪 / 打字投递 / 重启前言） */
const ACP_MCP_ENV_VARS = CODEX_MCP_ENV_VARS.filter((k) => k !== "TMUX" && k !== "TMUX_PANE" && k !== "CLAUDESTRA_CODEX_PREAMBLE");

export function acpAgentCommand(env: Record<string, string | undefined>, bunBin: string, root?: string): { cmd: string[]; stub: boolean } | { error: string } {
  if (isSandbox(env)) {
    const stub = repoStubPath();
    return stub ? { cmd: [bunBin, stub], stub: true } : { error: "沙箱里找不到本仓的 scripts/acp-stub.ts（或它的真实路径不在本仓里），不起 ACP 适配器" };
  }
  const override = env[ACP_AGENT_ENV]?.trim();
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
  return installed.ok ? { cmd: [bunBin, installed.path], stub: false } : { error: installed.hint };
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
}

export function adapterEnv(s: AdapterEnvSpec): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.base)) if (typeof v === "string") env[k] = v;
  for (const k of ["TMUX", "TMUX_PANE", "CLAUDESTRA_CODEX_PREAMBLE", "DISCORD_CHANNEL_ID", "BRIDGE_URL", "BRIDGE_PORT", ACP_AGENT_ENV]) delete env[k];
  const config: Record<string, unknown> = { check_for_update_on_startup: false };
  if (s.developerInstructions) config.developer_instructions = s.developerInstructions;
  if (s.channel) {
    config.mcp_servers = { [s.mcpName]: { command: s.bunBin, args: [s.channelServer], env_vars: ACP_MCP_ENV_VARS } };
    Object.assign(env, {
      DISCORD_CHANNEL_ID: s.channel.channelId,
      BRIDGE_URL: s.channel.proxyUrl,
      CLAUDESTRA_AGENT: s.channel.agentName,
      CLAUDESTRA_RUNTIME: "codex",
      CLAUDESTRA_SESSION_ID: s.channel.sessionId,
      MCP_NAME: s.mcpName,
    });
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

/** 起子进程；stderr 按行交给 log（适配器自己的详细日志另在 APP_SERVER_LOGS） */
export function spawnAdapter(cmd: string[], env: Record<string, string>, cwd: string, log: (msg: string) => void): AdapterProc {
  if (isSandbox(env) && env.HOME) mkdirSync(env.HOME, { recursive: true }); // 沙箱里隔离出来的 HOME（adapterEnv）第一次用时还不存在
  const proc: Subprocess<"pipe", "pipe", "pipe"> = Bun.spawn(cmd, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const closeCbs: ((why: string) => void)[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>, cb: (c: Uint8Array) => void) => {
    for await (const chunk of stream) cb(chunk);
  };
  let dataCb: (c: Uint8Array) => void = () => {};
  void pump(proc.stdout, (c) => dataCb(c)).catch((e) => log(`适配器 stdout 读取出错：${e}`));
  const dec = new TextDecoder();
  void pump(proc.stderr, (c) => {
    for (const line of dec.decode(c).split("\n")) if (line.trim()) log(`[codex-acp] ${line.slice(0, 300)}`);
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
