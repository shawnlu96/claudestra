/** 只认 mcpServers 的运行时（Pi、OpenCode）怎么交 channel-server：回环代理的地址和 token 只在这里，不进适配器的环境 */
import { channelServerEnv, type AdapterEnvSpec } from "../acp/adapter-proc.js";
import type { AcpMcpServer } from "./contract.js";

export function stdioMcpServers(runtime: string): (s: AdapterEnvSpec) => AcpMcpServer[] {
  return (s) => {
    if (!s.channel || s.clean) return [];
    const env = Object.entries(channelServerEnv(s.channel, s.mcpName, runtime)).map(([name, value]) => ({ name, value }));
    return [{ name: s.mcpName, command: s.bunBin, args: [s.channelServer], env }];
  };
}
