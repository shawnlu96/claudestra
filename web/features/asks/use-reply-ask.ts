"use client";
import { useMemo } from "react";
import { useChatStore } from "@/features/chat/chat-store";
import type { ChatMessage } from "@/features/chat/type";
import { hintAskForWire } from "@/lib/api/asks";
import { deriveClicksFromLegacy } from "@/lib/chat/reply-clicks";
import { useT } from "@/lib/i18n";
import { askForReply, clicksFromAnswer, closedText } from "./asks-model";
import { useAsks } from "./asks-store";

/**
 * 聊天气泡里的按钮 / 选单跟着它建出的「待你处理」走（reply-components.tsx 一行调用）：
 * - clicks：每行已答值（与 m.replyClicks 同形）；ask 已在别处答了就用它的答案补上，高亮所选；
 * - locked：ask 已结案（答了 / 过期 / 撤销）→ 整条锁住；status：按钮下面那行小字；
 * - beforeSend(wire)：点之前调——已结案返回 false 不发；还开着就把 askId 交给 sendMessage（lib/api/asks.ts 的小抄）。
 */
export function useReplyAsk(m: ChatMessage) {
  const t = useT();
  const rows = m.replyComponents;
  const agent = useChatStore((s) => s.state.activeAgent);
  const { asks } = useAsks();
  const ask = useMemo(() => askForReply(asks, agent, rows, m.replyTs ?? m.ts), [asks, agent, rows, m.replyTs, m.ts]);
  const closed = ask && ask.state !== "open" ? ask : null;
  // 老快照只有单值 replyClickedId 时退化推导（bug ①，deriveClicksFromLegacy）
  const clicks = useMemo(() => {
    const own = m.replyClicks ?? deriveClicksFromLegacy(m.replyClickedId, rows);
    return closed?.answer && rows ? { ...clicksFromAnswer(rows, closed.answer.choices), ...own } : own;
  }, [m.replyClicks, m.replyClickedId, rows, closed]);
  const beforeSend = (wire: string): boolean => {
    if (closed) return false;
    if (ask) hintAskForWire(agent, wire, ask.id);
    return true;
  };
  const status = closed ? closedText(closed, t) : ask ? t("待你处理") : null;
  return { clicks, locked: !!closed, status, beforeSend };
}
