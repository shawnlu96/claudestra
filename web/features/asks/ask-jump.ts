/**
 * 跳到一条「待你处理」的原消息（T11b 第 6 条）：问 bridge 原消息在发起 agent 会话里的哪一行（locateAsk），打开那个 agent，
 * 再用搜索跳转同一套 store.jumpToContext（按 seq 拉那一窗历史、更早的照常往上翻），message-list 滚到那条并闪一下。
 * 定位不到（运行时弹框的会话换了、Pi / Codex 会话）就只打开对话。网页和 iOS 壳走同一条路。
 */
import { locateAsk } from "@/lib/api/asks";
import { uiAgentName } from "@/lib/chat/agents";

interface JumpStore {
  openAgent(name: string): Promise<void>;
  jumpToContext(sessionId: string, seq: number): Promise<void>;
}

export async function jumpToAsk(store: JumpStore, ask: { id: string; fromAgent: string | null }): Promise<void> {
  const loc = await locateAsk(ask.id).catch(() => null); // 定位不到就只打开对话
  const agent = loc?.agent ?? ask.fromAgent;
  if (!agent) return;
  await store.openAgent(uiAgentName(agent));
  if (loc) await store.jumpToContext(loc.sessionId, loc.seq);
}
