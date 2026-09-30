/**
 * 派单工具在 bridge 上的路由（纯逻辑，IO 由 bridge/order-tools.ts 注入）：先过身份门，再交给按工具名登记的 handler。
 * 身份门在 handler 之前、且是唯一入口：verified=false（没凭据、凭据被新启动顶掉、ACP 代理标了降级）一律回 identity_unverified，
 * handler 根本不会被调，所以不可能写台账或投递。handler 拿到的调用方 agent / 会话 / 家族 / 频道都来自身份，不来自参数。
 * tests/order-tool-route.test.ts。
 */
import { IDENTITY_UNVERIFIED, requireVerified, type CallerIdentity } from "./caller-identity.js";

export type OrderToolResult = ({ ok: true } & Record<string, unknown>) | { ok: false; code: string; error: string };

/** 已验证的调用方：agent / 频道一定有；sessionId 可能为空（registry 还没记上会话） */
export interface VerifiedCall {
  agent: string;
  sessionId: string | null;
  /** registry 的 runtime：claude-code / codex / pi */
  family: string | null;
  /** 调用方连接注册的频道（大总管 = 控制频道）：写台账时 manager 按它算 actor */
  channelId: string;
}

export type OrderToolHandler = (call: VerifiedCall, args: unknown) => Promise<OrderToolResult>;

export const refuse = (code: string, error: string): OrderToolResult => ({ ok: false, code, error });

export async function routeOrderTool(
  tool: unknown, identity: CallerIdentity, channelId: string | undefined, args: unknown, handlers: Readonly<Record<string, OrderToolHandler>>,
): Promise<OrderToolResult> {
  const gate = requireVerified(identity);
  if (!gate.ok) return refuse(IDENTITY_UNVERIFIED, "调用方身份未验证（不是 Claudestra 用新凭据启动的会话，或经代理降级），派单工具一律拒绝；用 ledger CLI 或重启 agent");
  // verified 已经要求频道有主；这里再兜一次，缺了宁可拒，也不让 manager 以 owner 身份（没有频道号）写台账
  if (!identity.agent || !channelId) return refuse(IDENTITY_UNVERIFIED, "认不出调用方的 agent 或频道");
  const handler = typeof tool === "string" && Object.hasOwn(handlers, tool) ? handlers[tool] : undefined;
  if (!handler) return refuse("unknown_tool", `没有派单工具 ${String(tool).slice(0, 40)}`);
  return handler({ agent: identity.agent, sessionId: identity.sessionId, family: identity.family, channelId }, args);
}
