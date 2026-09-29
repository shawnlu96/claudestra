"use client";
import { useMemo, useState } from "react";
import type { InlineActionCtx } from "@/components/domd/inline-button";
import { useReplyAsk } from "@/features/asks/use-reply-ask";
import { plainLabel } from "@/lib/chat/inline-buttons";
import { useChatStore, useChatStoreApi } from "../chat-store";
import { agentChipIndex, agentLabelKey } from "../message-text";
import type { ChatMessage } from "../type";

/**
 * 行内按钮（`[[{#id .style}label]]`）的 context：DOMD 深处的 InlineButton 经它拿到本条消息的回投回调。点击复用块级组件的
 * clickReplyComponent（同 wire `[button:<id>]`、同 replyClicks，rowKey 前缀 `i:`），并跟块级一样先过 useReplyAsk：带上 askId、ask 结案后整条锁住。
 * agent chip（`[[{.agent}name]]`）的可跳转名单：name / displayName 都认，只订阅压成字符串的 agentLabelKey（D8-4，message-text.ts）。
 */
export function useInlineActions(m: ChatMessage): InlineActionCtx {
  const store = useChatStoreApi();
  const [busy, setBusy] = useState(false);
  const agentKey = useChatStore((s) => agentLabelKey(s.state.agents));
  const { inline, beforeSend } = useReplyAsk(m);
  return useMemo<InlineActionCtx>(() => {
    const { labels, resolve } = agentChipIndex(agentKey);
    return {
      clicks: { ...inline.clicks, ...m.replyClicks },
      busy,
      locked: inline.locked,
      lockHint: inline.lockHint,
      onClick: async (id, label) => {
        const wire = `[button:${id}]`;
        if (!beforeSend(wire)) return;
        setBusy(true);
        try {
          await store.clickReplyComponent(m.id, `i:${id}`, id, plainLabel(label), wire);
        } finally {
          setBusy(false);
        }
      },
      agents: labels,
      openAgent: (label) => {
        const name = resolve(label);
        if (name) void store.openAgent(name);
      },
    };
  }, [m.id, m.replyClicks, busy, store, agentKey, inline, beforeSend]);
}
