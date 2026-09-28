import type { ChatMessage } from "./type";

/**
 * 守门结果到达后要不要解掉「思考中」：send() 乐观地把 streaming/awaitingChunk 置真，而被守门拦下的消息根本没进
 * agent，永远不会有 done 事件——不解锁就一直三个点，直到切会话（owner 2026-09-28）。只在还没收到任何输出
 * （awaitingChunk）且被拦原文对得上本端一条乐观气泡（local，按 wire 优先）时才解锁：agent 若本来就在回合中，
 * 下一段输出会重新上锁；别人发的消息被拦，不动我们的状态。
 */
export function guardSettles(state: { awaitingChunk: boolean; messages: ChatMessage[] }, text: string | undefined): boolean {
  if (!state.awaitingChunk || !text) return false;
  return state.messages.some((m) => m.role === "user" && m.local && (m.wire ?? m.content) === text);
}
