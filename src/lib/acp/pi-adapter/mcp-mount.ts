/**
 * Pi 扩展：把 ACP 适配器交来的 MCP server（session/new|resume 的 mcpServers，经环境变量传进 pi）挂进本会话。
 * exposure 固定 direct：缺省的 codemode 不把工具声明给模型，模型就看不到 mcp__claudestra__reply，也不报错。
 * 挂载要靠 pi 的内置 MCP 支持（-e builtin:mcp，见 args.ts）；JSON 坏了照样抛，pi 会发 extension_error，适配器记日志。
 * 读完就从 pi 的环境里删掉：pi 的 bash 工具按调用时的 process.env 起子进程，留着的话回环代理的地址和 token 模型一个 env 就看得到；
 * MCP server 自己的 env 已经在配置里，删了不影响它。
 */

export const PI_MCP_SERVERS_ENV = "CLAUDESTRA_PI_MCP_SERVERS";

interface MountApi {
  registerMcpServer(name: string, config: Record<string, unknown>): void;
}

export default function mountMcpServers(pi: MountApi, env: Record<string, string | undefined> = process.env): void {
  const raw = env[PI_MCP_SERVERS_ENV];
  if (!raw) return;
  delete env[PI_MCP_SERVERS_ENV];
  const servers = JSON.parse(raw) as Record<string, Record<string, unknown>>;
  for (const [name, config] of Object.entries(servers)) pi.registerMcpServer(name, { ...config, exposure: "direct" });
}
