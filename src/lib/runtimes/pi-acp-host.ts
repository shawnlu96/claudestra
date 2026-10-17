/** Pi 的 ACP 宿主描述（runtimes/contract.ts AcpHostRuntime）：起仓库里的 Pi 适配器，channel-server 只经 mcpServers 交过去（acp-mcp.ts）。 */
import { hostEnvBase, type AgentCommand } from "../acp/adapter-proc.js";
import { PI_ACP_ADAPTER_MAIN } from "../acp/pi-adapter/main.js";
import { sandboxPiEnv, sandboxPiProblem } from "../acp/pi-adapter/sandbox-policy.js";
import { stdioMcpServers } from "./acp-mcp.js";
import type { AcpHostRuntime } from "./contract.js";

/** Pi 的能力档等参数（JSON 字符串数组），由 runtimes/pi-acp.ts 的启动命令给，原样排在适配器的 pi 参数前面 */
export const PI_ARGS_ENV = "CLAUDESTRA_PI_ARGS";

function piAgentCommand(env: Record<string, string | undefined>, bunBin: string, clean: boolean): AgentCommand {
  if (clean) return { error: "出借 worker 只支持 Codex，不起 Pi 的 ACP 适配器" };
  // 必需：能力档（minimal / 工具黑白名单）都在这里，缺了按空数组起就是 pi 的默认发现集 + 默认工具，不能凑合
  const raw = env[PI_ARGS_ENV];
  if (!raw) return { error: `缺 ${PI_ARGS_ENV}（pi 参数在启动文件里，没读到就不起）` };
  let args: unknown = null;
  try {
    args = JSON.parse(raw);
  } catch {
    /* 不是 JSON：落到下面报错 */
  }
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return { error: `${PI_ARGS_ENV} 要是 JSON 字符串数组` };
  const refused = sandboxPiProblem(env, args); // 沙箱：目录钉在沙箱根、只用最小发现集（manager 那头已按同一规则拼过，这里再查一遍）
  return refused ? { error: refused } : { cmd: [bunBin, PI_ACP_ADAPTER_MAIN, ...args], stub: false };
}

export const PI_ACP_HOST: AcpHostRuntime = {
  id: "pi", label: "Pi", logLabel: "pi-acp",
  // 压缩完成认 Pi 适配器的中性记号 _meta.claudestra.compacted（pi-adapter/map.ts）
  compactFrom: "claudestra-meta",
  agentCommand: piAgentCommand,
  adapterEnv: (s) => sandboxPiEnv(hostEnvBase(s), s.base),
  mcpServers: stdioMcpServers("pi"),
};
