/**
 * MCP 命名族（rename.mcp）：旧族 claudestra、新族 floka 的服务名、工具前缀与开关解析。
 * 服务名就是 CC 配置里的键：工具名 mcp__<键>__*、`--dangerously-load-development-channels server:<键>` 都跟着它走。
 * 纯函数、不读文件：bridge（watcher）与 manager / launcher（启动）两边都引。单测 tests/floka-mcp.test.ts。
 */

export type McpFamily = "claudestra" | "floka";
export type RenameMcpMode = "off" | "observe" | "on";

/** 旧族：setup / doctor 在用户级 `claude mcp add` 注册的就是它；没有任何会话记录时一律回到它 */
export const LEGACY_FAMILY: McpFamily = "claudestra";
export const NEW_FAMILY: McpFamily = "floka";
export const MCP_FAMILIES: readonly McpFamily[] = [LEGACY_FAMILY, NEW_FAMILY];

export const isMcpFamily = (v: unknown): v is McpFamily => v === LEGACY_FAMILY || v === NEW_FAMILY;

/** 与 cli-install / bridge config 同一规则：服务名里的 - 在工具名里是 _ */
export const mcpToolPrefix = (server: string): string => `mcp__${server.replace(/-/g, "_")}__`;

/** rename.mcp：缺省、写错、非字符串一律 off（打错字不能变成换名） */
export function parseRenameMcpMode(config: unknown): RenameMcpMode {
  const rename = config && typeof config === "object" ? (config as { rename?: unknown }).rename : undefined;
  const v = rename && typeof rename === "object" ? (rename as { mcp?: unknown }).mcp : undefined;
  return v === "observe" || v === "on" ? v : "off";
}

/** 工具名属于哪个族（两族前缀都认）；别的服务的工具返回 null */
export function familyOfTool(name: string): McpFamily | null {
  for (const f of MCP_FAMILIES) if (name.startsWith(mcpToolPrefix(f))) return f;
  return null;
}
