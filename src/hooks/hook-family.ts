/**
 * hook 所在会话的 MCP 命名族：两族共用同一条 hook 命令，族按会话记录（floka-mcp/store.ts）取，没记录就是旧族。
 * 状态根跟着会话进程的环境走（CLAUDESTRA_ / FLOKA_STATE_DIR 按 rename.env 解析），两种写法落同一个根。
 * 动态 import：store 经 lib/paths.ts 取状态目录，加载期可能被沙箱闸拒绝；hook 不能因此起不来。
 */
import { LEGACY_FAMILY, mcpToolPrefix, type McpFamily } from "../lib/floka-mcp/families.js";

export async function hookSessionFamily(sessionId: unknown): Promise<{ family: McpFamily; toolPrefix: string }> {
  let family: McpFamily = LEGACY_FAMILY;
  if (typeof sessionId === "string") {
    try {
      const { readSessionFamily } = await import("../lib/floka-mcp/store.js");
      family = readSessionFamily(sessionId) ?? LEGACY_FAMILY;
    } catch {
      family = LEGACY_FAMILY; // 读不到记录按旧族：与 launch 侧「没记录 = 旧族」同一缺省，最多少认一次新族
    }
  }
  return { family, toolPrefix: mcpToolPrefix(family) };
}
