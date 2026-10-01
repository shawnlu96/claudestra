/**
 * 入站消息投递给本地 agent 成功后的两件事（bridge.ts deliverToLocal）：
 * - 镜像成 chat_message(in) 事件的 data。srcKind（user = Discord 人类 / api = Web 用户 / local = agent·bridge）让网页把他端用户发言实时画成气泡、
 *   排除 agent/bridge 注入；fromId（user_id）让网页认出本人的其它来源。attachments 是 bridge 真收下的附件路径（和 channel 头属性同一份）：
 *   网页给外源消息画附件卡片只认它，不认正文里的 [attachment: …] 行（tests/inbound-event.test.ts）。
 * - 非 CC 目标记入站账（lib/inbound-ledger.ts），历史 API 按 agent 取查账函数（tests/inbound-ledger.test.ts）。
 */
import { forgetInbound, inboundLookup, noteInbound, type InboundLookup } from "../lib/inbound-ledger.js";
import { isAcpChannel } from "./acp-state.js";
import { webDb } from "./local-api/db.js";
import type { Envelope } from "./router.js";

export function inboundEventData(env: Envelope, meta: Record<string, string>): Record<string, unknown> {
  const atts = env.meta.attachments?.filter(Boolean) ?? [];
  return {
    direction: "in", from: meta.user || "?", fromId: meta.user_id, srcKind: env.from.kind, text: env.content, threadId: env.meta.threadId,
    ...env.meta.askEcho,
    ...(atts.length ? { attachments: atts } : {}),
  };
}

/**
 * runtime 是目标 register 时自报的（CC 不报 → 不记：CC 的 <channel> 按 MCP meta 写，本来就认）。ACP 宿主和 tmux Codex 的 channel-server
 * 都把每条入站整块包进 <channel message_id=…>，才记账；tmux 版 Pi 原样投进记录，外源能照抄 owner 的整块包装，所以清掉该 agent 的账。
 * 从不抛错：账的事不能影响投递，库打不开就只记日志。
 */
export function noteForeignInbound(runtime: string | undefined, channelId: string, agent: string, content: string, meta: Record<string, string>): void {
  if (!runtime) return;
  try {
    if (runtime === "codex" || isAcpChannel(channelId)) noteInbound(webDb(), agent, meta.message_id, content, meta, Date.now());
    else forgetInbound(webDb(), agent);
  } catch (e) {
    console.error(`入站账：web 状态库打不开，跳过（投递照常）: ${(e as Error).message}`);
  }
}

/** 历史 / 搜索按 agent 名取查账函数；库打不开就给一个永远查不到的（历史退回保守，不 500） */
export function inboundFor(agent: string): InboundLookup {
  try {
    return inboundLookup(webDb(), agent);
  } catch (e) {
    console.error(`入站账：web 状态库打不开，历史按保守显示: ${(e as Error).message}`);
    return () => null;
  }
}
