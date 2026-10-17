/** Pi 的 ACP 宿主描述（runtimes/contract.ts AcpHostRuntime）：起仓库里的 Pi 适配器，channel-server 只经 mcpServers 交过去。 */
import { channelServerEnv, hostEnvBase, type AdapterEnvSpec, type AgentCommand } from "../acp/adapter-proc.js";
import { PI_ACP_ADAPTER_MAIN } from "../acp/pi-adapter/main.js";
import { sandboxPiEnv, sandboxPiProblem } from "../acp/pi-adapter/sandbox-policy.js";
import type { AcpHostRuntime, AcpMcpServer } from "./contract.js";

/** Pi 的能力档等参数（JSON 字符串数组），由 runtimes/pi-acp.ts 的启动命令给，原样排在适配器的 pi 参数前面 */
export const PI_ARGS_ENV = "CLAUDESTRA_PI_ARGS";

function piAgentCommand(env: Record<string, string | undefined>, bunBin: string, clean: boolean): AgentCommand {
  if (clean) return { error: "出借 worker 只支持 Codex，不起 Pi 的 ACP 适配器" };
  let args: unknown = null;
  try {
    args = JSON.parse(env[PI_ARGS_ENV] || "[]");
  } catch {
    /* 不是 JSON：落到下面报错 */
  }
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return { error: `${PI_ARGS_ENV} 要是 JSON 字符串数组` };
  const refused = sandboxPiProblem(env, args); // 沙箱：目录钉在沙箱根、只用最小发现集（manager 那头已按同一规则拼过，这里再查一遍）
  return refused ? { error: refused } : { cmd: [bunBin, PI_ACP_ADAPTER_MAIN, ...args], stub: false };
}

/** Pi 只认 mcpServers：回环代理的地址和 token 只在这里（适配器转给 pi 的挂载扩展，读完即删），不进适配器的环境 */
function piMcpServers(s: AdapterEnvSpec): AcpMcpServer[] {
  if (!s.channel || s.clean) return [];
  const env = Object.entries(channelServerEnv(s.channel, s.mcpName, "pi")).map(([name, value]) => ({ name, value }));
  return [{ name: s.mcpName, command: s.bunBin, args: [s.channelServer], env }];
}

export const PI_ACP_HOST: AcpHostRuntime = {
  id: "pi", label: "Pi", logLabel: "pi-acp",
  // 压缩完成认 Pi 适配器的中性记号 _meta.claudestra.compacted（pi-adapter/map.ts）
  translator: { compactFrom: "claudestra-meta" },
  agentCommand: piAgentCommand,
  adapterEnv: (s) => sandboxPiEnv(hostEnvBase(s), s.base),
  mcpServers: piMcpServers,
};
