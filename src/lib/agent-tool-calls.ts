/**
 * channel-server 里 agent 间协作几个工具的执行：send_to_agent / forward_to_agent / check_inbox（工具说明在 agent-tool-docs.ts）。
 * 从 channel-server.ts 搬出（那边在行数上限），bridgeRequest 由调用方传进来。
 */
import { CHECK_INBOX_DESCRIPTION } from "./agent-tool-docs.js";

type BridgeRequest = (msg: any, timeoutMs?: number) => Promise<any>;

/** forward_to_agent：转交（规则 lib/forward.ts，投递 bridge/forward.ts） */
export async function forwardTool(bridgeRequest: BridgeRequest, args: any) {
  const r = await bridgeRequest({ type: "forward_to_agent", messageId: args?.message_id || "", target: args?.target || "", reason: args?.reason || "" });
  return { content: [{ type: "text" as const, text: `已转给 ${r.target}，它会直接回答用户。**不要再 reply**，结束本轮即可。` }] };
}

/** send_to_agent：从工具分发里原样搬出（分发函数太长） */
export async function sendToAgentTool(bridgeRequest: BridgeRequest, args: any) {
  const oneShot = args?.oneShot === true;
  const result = await bridgeRequest({
    type: "route_to_agent",
    targetName: args?.target || "",
    text: args?.text || "",
    expecting: typeof args?.expecting === "string" ? args.expecting : undefined,
    oneShot,
  });
  // bridge 会把对方的下一条 reply push 回来（oneShot 不会）；queued = 对方在回合中、已排队落盘，这一轮结束才收到（它也可以用 check_inbox 提前取），别当成没发出去重发
  const sent = result.queued ? `${result.targetName} 正在忙，消息已排队（bridge 重启也不丢），它这一轮结束就会收到。` : "";
  const advice = oneShot
    ? `${sent}消息已 fire-and-forget 发给 ${result.targetName}。**不期待任何 push-back**。对方收到会自己判断要不要回，可能直接 end_turn。end_turn 等用户下一步指示即可。`
    : result.pushBack
    ? `${sent}消息已发送给 ${result.targetName}。**不要轮询 fetch_messages** —— bridge 会在对方 reply 时自动把回复 push 到你这边作为新的入站消息，结束本轮等即可。`
    : `消息已发送给 ${result.targetName}。如需获取回复，可用 fetch_messages 轮询频道 ${result.targetChannelId}`;
  return { content: [{ type: "text" as const, text: advice }] };
}

export const CHECK_INBOX_TOOL = {
  name: "check_inbox",
  description: CHECK_INBOX_DESCRIPTION,
  inputSchema: {
    type: "object" as const,
    properties: { ack: { type: "string", description: "上一次领到的批次号（inbox_xxx）：确认它已处理完，顺带领下一批" } },
  },
};

/** check_inbox：领取排队给我的消息（bridge/inbox.ts），ack 确认上一批后才出队 */
export async function checkInboxTool(bridgeRequest: BridgeRequest, args: Record<string, unknown> = {}) {
  const r = await bridgeRequest({ type: "check_inbox", ...(typeof args.ack === "string" && args.ack ? { ack: args.ack } : {}) });
  return { content: [{ type: "text" as const, text: String(r.text || "收件箱是空的。") }] };
}
