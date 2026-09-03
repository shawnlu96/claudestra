import type { ChatMessage } from "./type";

/**
 * history wire 瘦身的客户端还原（与 BFF history route 的 slimForWire 成对）。
 *
 * wire 上 assistant 气泡只发 segments（叙述/工具/回复的交错真序），content /
 * toolCalls / replyText 三个冗余字段（实测 551kB 里占 260kB）在这里派生回来，
 * store 内部与渲染层的既有依赖（对账 norm(content)、复制、搜索高亮）零改动。
 *
 * 派生规则严格对齐 BFF toChatMessages 的累积逻辑：
 * - content   = text 段按序 "\n\n" 拼接（route 里 group.content 的构造方式）
 * - toolCalls = tools 段按序平铺
 * - replyText = reply 段按序 "\n" 拼接（route 里 group.replyText 的构造方式）
 *
 * 老格式兼容：content 已在（旧服务端/缓存响应）则原样返回，幂等。
 */
export function hydrateHistoryMessages(msgs: ChatMessage[]): ChatMessage[] {
  return msgs.map((m) => {
    if (m.role !== "assistant" || !m.segments?.length) return m;
    if (typeof m.content === "string") return m;
    const texts: string[] = [];
    const replies: string[] = [];
    const tools: NonNullable<ChatMessage["toolCalls"]> = [];
    for (const seg of m.segments) {
      if (seg.kind === "text") {
        if (!seg.progress) texts.push(seg.text); // 进度句不进 content(与直播侧一致)
      }
      else if (seg.kind === "reply") replies.push(seg.text);
      else if (seg.kind === "tools") tools.push(...seg.tools);
    }
    return {
      ...m,
      content: texts.join("\n\n"),
      ...(tools.length ? { toolCalls: tools } : {}),
      ...(replies.length ? { replyText: replies.join("\n") } : {}),
    };
  });
}
