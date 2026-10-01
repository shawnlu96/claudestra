/**
 * 适配器起 pi 的参数：rpc 模式 + 调用方给的能力档参数 + 挂 MCP 的两件套 + 会话 id。
 * `-e builtin:mcp` 无条件带上：能力档的 --no-extensions 会连内置 MCP 一起关掉，模型就静默看不到 reply（pi 0.99.1 实测，
 * 它放在路径扩展之后也照样生效）。会话由适配器按 ACP 的 sessionId 选，调用方再带会话类参数就是宿主的 bug，直接拒。
 * tests/pi-acp-args.test.ts。
 */
import { fileURLToPath } from "node:url";

export const MCP_MOUNT_EXTENSION = fileURLToPath(new URL("./mcp-mount.ts", import.meta.url));

const OWNED_FLAGS = new Set(["--mode", "--session-id", "--session", "--continue", "-c", "--resume", "-r", "--fork", "--no-session"]);

export function piRpcArgs(sessionId: string, baseArgs: readonly string[] = []): string[] {
  if (!sessionId) throw new Error("起 pi 缺会话 id");
  const clash = baseArgs.find((a) => OWNED_FLAGS.has(a));
  if (clash) throw new Error(`pi 的 ${clash} 由 ACP 适配器决定，调用方不能再传`);
  return ["--mode", "rpc", ...baseArgs, "-e", "builtin:mcp", "-e", MCP_MOUNT_EXTENSION, "--session-id", sessionId];
}
