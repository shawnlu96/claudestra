/**
 * Pi 扩展：把 ACP 适配器交来的 MCP server（session/new|resume 的 mcpServers，经环境变量传进 pi）挂进本会话。
 * exposure 固定 direct：缺省的 codemode 不把工具声明给模型，模型就看不到 mcp__claudestra__reply，也不报错。
 * 挂载要靠 pi 的内置 MCP 支持（-e builtin:mcp，见 args.ts）；JSON 坏了照样抛，pi 会发 extension_error，适配器记日志。
 * 读完就从 pi 的环境里删掉：pi 的 bash 工具按调用时的 process.env 起子进程，留着的话回环代理的地址和 token 模型一个 env 就看得到。
 * session_start 时（内置 MCP 扩展也在这一刻读 mcp.json）再查一次撞名，结果用 setStatus 报给适配器（MOUNT_STATUS_KEY）。
 */
import { piAgentDirOf } from "../../pi-path.js";
import { piMcpClash } from "./mcp-clash.js";

export const PI_MCP_SERVERS_ENV = "CLAUDESTRA_PI_MCP_SERVERS";
/** 挂载扩展的状态键：值是 MOUNT_OK 或撞名原因；rpc 模式下 pi 把 setStatus 原样作为 extension_ui_request 吐给适配器 */
export const MOUNT_STATUS_KEY = "claudestra-mcp-mount";
export const MOUNT_OK = "ok";

interface MountCtx {
  cwd: string;
  ui: { setStatus(key: string, text: string | undefined): void };
}

interface MountApi {
  registerMcpServer(name: string, config: Record<string, unknown>): void;
  on?(event: "session_start", handler: (event: unknown, ctx: MountCtx) => void): void;
}

export default function mountMcpServers(pi: MountApi, env: Record<string, string | undefined> = process.env): void {
  const raw = env[PI_MCP_SERVERS_ENV];
  if (!raw) return;
  delete env[PI_MCP_SERVERS_ENV];
  const servers = JSON.parse(raw) as Record<string, Record<string, unknown>>;
  for (const [name, config] of Object.entries(servers)) pi.registerMcpServer(name, { ...config, exposure: "direct" });
  const names = Object.keys(servers);
  pi.on?.("session_start", (_e, ctx) => ctx.ui.setStatus(MOUNT_STATUS_KEY, piMcpClash(names, ctx.cwd, piAgentDirOf(env, ctx.cwd)) ?? MOUNT_OK));
}
