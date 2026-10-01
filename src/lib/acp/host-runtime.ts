/**
 * ACP 宿主里按运行时不同的几处（docs/design/pi-acp-eval.md §6）：起哪个适配器、给它什么环境、channel-server 怎么交过去、
 * /clear 要不要引导轮、卡片和日志里怎么称呼。其余（回合、出站确认、工具代理、失败分类）两家共用宿主的同一套。
 * 宿主命令不带 CLAUDESTRA_ACP_RUNTIME = codex（老命令照旧）；认不出的值直接抛，不猜。tests/acp-host-runtime.test.ts。
 */
import { BOOTSTRAP_PROMPT } from "../codex-launch.js";
import { isSandbox } from "../sandbox.js";
import { acpAgentCommand, adapterEnv, channelServerEnv, hostEnvBase, type AdapterEnvSpec } from "./adapter-proc.js";
import { PI_ACP_ADAPTER_MAIN } from "./pi-adapter/main.js";

export const ACP_RUNTIME_ENV = "CLAUDESTRA_ACP_RUNTIME";
/** Pi 的能力档等参数（JSON 字符串数组），由 runtimes/pi-acp.ts 的启动命令给，原样排在适配器的 pi 参数前面 */
export const PI_ARGS_ENV = "CLAUDESTRA_PI_ARGS";

/** ACP 的 stdio MCP server（session/new|resume 的 mcpServers 一项） */
interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

type AgentCommand = { cmd: string[]; stub: boolean } | { error: string };

export interface AcpRuntime {
  readonly id: "codex" | "pi";
  /** 失败 / 授权卡与日志里的称呼 */
  readonly label: string;
  /** 适配器 stderr 的行前缀 */
  readonly logLabel: string;
  /** /clear 的新会话先跑这一轮：Codex 新线程跑完一轮才落盘；Pi 的 --session-id 开会话即可，不要 */
  readonly clearBootstrap?: string;
  agentCommand(env: Record<string, string | undefined>, bunBin: string, clean: boolean): AgentCommand;
  adapterEnv(spec: AdapterEnvSpec): Record<string, string>;
  /** 交给 session/new|resume|fork 的 mcpServers */
  mcpServers(spec: AdapterEnvSpec): AcpMcpServer[];
}

function piAgentCommand(env: Record<string, string | undefined>, bunBin: string, clean: boolean): AgentCommand {
  if (clean) return { error: "出借 worker 只支持 Codex，不起 Pi 的 ACP 适配器" };
  if (isSandbox(env)) return { error: "沙箱里还不能起 Pi 的 ACP 适配器（沙箱策略另行设计）" };
  let args: unknown = null;
  try {
    args = JSON.parse(env[PI_ARGS_ENV] || "[]");
  } catch {
    /* 不是 JSON：落到下面报错 */
  }
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return { error: `${PI_ARGS_ENV} 要是 JSON 字符串数组` };
  return { cmd: [bunBin, PI_ACP_ADAPTER_MAIN, ...args], stub: false };
}

/** Pi 只认 mcpServers：回环代理的地址和 token 只在这里（适配器转给 pi 的挂载扩展，读完即删），不进适配器的环境 */
function piMcpServers(s: AdapterEnvSpec): AcpMcpServer[] {
  if (!s.channel || s.clean) return [];
  const env = Object.entries(channelServerEnv(s.channel, s.mcpName, "pi")).map(([name, value]) => ({ name, value }));
  return [{ name: s.mcpName, command: s.bunBin, args: [s.channelServer], env }];
}

const RUNTIMES: Record<string, AcpRuntime> = {
  codex: {
    id: "codex", label: "Codex", logLabel: "codex-acp", clearBootstrap: BOOTSTRAP_PROMPT,
    agentCommand: (env, bunBin, clean) => acpAgentCommand(env, bunBin, undefined, clean),
    adapterEnv,
    // channel-server 已在 CODEX_CONFIG 里；codex-acp 会丢掉和 config 同名的 mcpServers 项，传了也白传
    mcpServers: () => [],
  },
  pi: { id: "pi", label: "Pi", logLabel: "pi-acp", agentCommand: piAgentCommand, adapterEnv: hostEnvBase, mcpServers: piMcpServers },
};

export function acpRuntime(id?: string): AcpRuntime {
  const rt = RUNTIMES[id || "codex"];
  if (!rt) throw new Error(`ACP 宿主不认识的运行时「${id}」（${ACP_RUNTIME_ENV} 只能是 ${Object.keys(RUNTIMES).join(" / ")}）`);
  return rt;
}
