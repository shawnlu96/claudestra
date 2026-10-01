/**
 * session/request_permission ↔「待你处理」卡（标题带运行时称呼）。Codex 用 agent-full-access（approval=never）、Pi 适配器不发，正常不会弹；
 * 这层是给以后收紧审批策略、或适配器改了默认时兜底的：卡片原样列出适配器给的选项，owner 点哪个回哪个 optionId。
 * 取消、超时、答了个不认识的 id，一律回 cancelled——适配器那边 cancelled 按拒绝处理（fail closed），宁可这次工具不跑。
 * MCP 工具的授权（_meta.is_mcp_tool_approval）只带 toolCallId，标题从 rawInput 里的 server / tool 拼。tests/acp-permissions.test.ts。
 */

export type PermissionResponse = { outcome: { outcome: "selected"; optionId: string } } | { outcome: { outcome: "cancelled" } };

export interface PermissionCard {
  toolCallId: string;
  title: string;
  /** 卡片正文：命令 / 参数的摘要（截断过） */
  detail: string;
  mcp: boolean;
  options: { id: string; label: string; style: "success" | "danger" | "secondary" }[];
}

const DETAIL_MAX = 600;
export const CANCELLED: PermissionResponse = { outcome: { outcome: "cancelled" } };

const styleOf = (kind: unknown): PermissionCard["options"][number]["style"] =>
  typeof kind === "string" && kind.startsWith("allow") ? "success" : typeof kind === "string" && kind.startsWith("reject") ? "danger" : "secondary";

function detailOf(raw: unknown): string {
  if (raw == null) return "";
  const r = raw as Record<string, unknown>;
  const text = typeof r.command === "string" ? r.command : Array.isArray(r.command) ? r.command.join(" ") : JSON.stringify(raw);
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text;
}

/** 请求参数 → 卡片；没有任何选项的请求返回 null（没东西可点，宿主直接回 cancelled） */
export function permissionCard(params: unknown, label = "Codex"): PermissionCard | null {
  const p = (params ?? {}) as Record<string, any>;
  const tc = (p.toolCall ?? {}) as Record<string, any>;
  const options = (Array.isArray(p.options) ? p.options : [])
    .filter((o: any) => o && typeof o.optionId === "string" && o.optionId)
    .map((o: any) => ({ id: o.optionId as string, label: typeof o.name === "string" && o.name ? o.name : o.optionId, style: styleOf(o.kind) }));
  if (!options.length) return null;
  const mcp = p._meta?.is_mcp_tool_approval === true;
  const raw = tc.rawInput as Record<string, unknown> | undefined;
  const mcpName = raw && typeof raw.server === "string" && typeof raw.tool === "string" ? `${raw.server}/${raw.tool}` : "";
  const title = typeof tc.title === "string" && tc.title ? tc.title : mcp ? `MCP 工具 ${mcpName || "调用"}` : "工具调用";
  return {
    toolCallId: typeof tc.toolCallId === "string" ? tc.toolCallId : "",
    title: `${label} 请求授权：${title}`,
    detail: detailOf(mcp && raw && "arguments" in raw ? raw.arguments : raw),
    mcp,
    options,
  };
}

/** owner 的选择 → 回给适配器的结果。null（取消 / 超时）或不在卡上的 id → cancelled */
export function permissionResponse(card: PermissionCard, picked: string | null): PermissionResponse {
  if (picked && card.options.some((o) => o.id === picked)) return { outcome: { outcome: "selected", optionId: picked } };
  return CANCELLED;
}
