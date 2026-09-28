"use client";
import { useCallback, useMemo } from "react";
import { useChatStore } from "@/features/chat/chat-store";
import type { ChatMessage } from "@/features/chat/type";
import { hintAskForWire } from "@/lib/api/asks";
import type { WebComponentRow } from "@/lib/chat/events";
import { parseInlineButtons } from "@/lib/chat/inline-buttons";
import { deriveClicksFromLegacy } from "@/lib/chat/reply-clicks";
import { useT } from "@/lib/i18n";
import { answeredGroups, askForReply, clicksFromAnswer, closedText, rowGroup } from "./asks-model";
import { useAsksIf } from "./asks-store";

/**
 * 聊天气泡里的按钮 / 选单 / 行内按钮跟着它建出的「待你处理」走（reply-components.tsx、use-inline-actions.ts 各一行调用）：
 * - clicks：每行已答值（与 m.replyClicks 同形）；ask 在别处答了（或多行里答了一部分）就用它的答案补上，高亮所选；
 * - rowLocked(row, ri)：ask 已结案 → 全锁；多行逐行作答时只锁答过的那一行（bridge 同规则），别的行照样能点；
 * - inline：行内按钮那一行（bridge 合成在最后一行）锁没锁、选了哪个；
 * - status：按钮下面那行小字；beforeSend(wire)：点之前调——已结案返回 false 不发；还开着就把 askId 交给 sendMessage。
 *   授权类不带 askId 的点击 bridge 一律不认（旧消息的按钮批不了新参数），所以行内按钮也必须走这里。
 */
export function useReplyAsk(m: ChatMessage) {
  const t = useT();
  const rows = m.replyComponents;
  const agent = useChatStore((s) => s.state.activeAgent);
  const inlineIds = useMemo(() => parseInlineButtons(m.replyText ?? "").map((b) => b.id), [m.replyText]);
  const { asks } = useAsksIf(!!rows?.length || inlineIds.length > 0);
  const ask = useMemo(() => askForReply(asks, agent, rows, m.replyTs ?? m.ts, inlineIds), [asks, agent, rows, m.replyTs, m.ts, inlineIds]);
  const closed = ask && ask.state !== "open" ? ask : null;
  const done = useMemo(() => (ask?.answer && rows ? answeredGroups(rows, ask.answer.choices) : new Set<string>()), [ask, rows]);
  // 老快照只有单值 replyClickedId 时退化推导（bug ①，deriveClicksFromLegacy）
  const clicks = useMemo(() => {
    const own = m.replyClicks ?? deriveClicksFromLegacy(m.replyClickedId, rows);
    return ask?.answer && rows ? { ...clicksFromAnswer(rows, ask.answer.choices), ...own } : own;
  }, [m.replyClicks, m.replyClickedId, rows, ask]);
  const inline = useMemo(() => {
    const picked = inlineIds.find((id) => ask?.answer?.choices.includes(`[button:${id}]`));
    return { locked: !!closed || !!picked, clicks: picked ? { [`i:${picked}`]: picked } : {} };
  }, [inlineIds, ask, closed]);
  const rowLocked = (row: WebComponentRow, ri: number) => !!closed || done.has(rowGroup(row, ri));
  const beforeSend = useCallback(
    (wire: string): boolean => {
      if (closed) return false;
      if (ask) hintAskForWire(agent, wire, ask.id);
      return true;
    },
    [closed, ask, agent],
  );
  const status = closed ? closedText(closed, t) : ask ? (done.size ? t("待你处理 · 已答 {n} 项", { n: done.size }) : t("待你处理")) : null;
  return { clicks, rowLocked, status, beforeSend, inline };
}
