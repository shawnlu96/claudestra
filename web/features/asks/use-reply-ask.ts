"use client";
import { useCallback, useMemo } from "react";
import { useChatStore } from "@/features/chat/chat-store";
import type { ChatMessage } from "@/features/chat/type";
import { hintAskForWire } from "@/lib/api/asks";
import type { WebComponentRow } from "@/lib/chat/events";
import { parseInlineButtons } from "@/lib/chat/inline-buttons";
import { deriveClicksFromLegacy } from "@/lib/chat/reply-clicks";
import { useT } from "@/lib/i18n";
import { answeredGroups, clicksFromAnswer, closedText, isMgmtButtonId, isMgmtRow, replyAskState, rowGroup } from "./asks-model";
import { useAsksIf } from "./asks-store";

/**
 * 聊天气泡里的按钮 / 选单 / 行内按钮跟着它建出的「待你处理」走（reply-components.tsx、use-inline-actions.ts 各一行调用）：
 * - clicks：每行已答值（与 m.replyClicks 同形）；ask 在别处答了（或多行里答了一部分）就用它的答案补上，高亮所选；
 * - rowLocked(row, ri)：ask 已结案 → 全锁；多行逐行作答时只锁答过的那一行（bridge 同规则），别的行照样能点；
 * - inline：行内按钮那一行（bridge 合成在最后一行）锁没锁、选了哪个、锁住要显示的提示（只有行内按钮的气泡）；
 * - status：按钮下面那行小字；beforeSend(wire)：点之前调——已结案（含早已移出列表的）、没认出的授权类返回 false 不发；其余把 askId（认出的，或气泡自带的）交给 sendMessage。
 *   授权类不带 askId 的点击 bridge 一律不认（旧消息的按钮批不了新参数），所以行内按钮也必须走这里。
 */
export function useReplyAsk(m: ChatMessage) {
  const t = useT();
  const rows = m.replyComponents;
  const agent = useChatStore((s) => s.state.activeAgent);
  const inlineIds = useMemo(() => parseInlineButtons(m.replyText ?? "").map((b) => b.id), [m.replyText]);
  const { asks, loaded, full } = useAsksIf(!!rows?.length || inlineIds.length > 0);
  const { replyTs, ts, replyAskId } = m;
  // 认没认出 ask、锁不锁（没认出的授权类去卡片上批；早已移出列表的按已结案锁；列表没到先不让点）：asks-model.ts replyAskState
  const list = !loaded ? "loading" : full ? "full" : "partial";
  const s = useMemo(() => replyAskState(asks, list, agent, { replyComponents: rows, replyTs, ts, replyAskId }, inlineIds), [asks, list, agent, rows, replyTs, ts, replyAskId, inlineIds]);
  const { ask, closed, orphan, gone, expired, waiting, blocked, hintId } = s;
  const lockHint = waiting ? t("正在核对这条是否已处理…") : orphan ? t("授权类请到「待你处理」卡片上批") : undefined;
  const done = useMemo(() => (ask?.answer && rows ? answeredGroups(rows, ask.answer.choices) : new Set<string>()), [ask, rows]);
  // 老快照只有单值 replyClickedId 时退化推导（bug ①，deriveClicksFromLegacy）
  const clicks = useMemo(() => {
    const own = m.replyClicks ?? deriveClicksFromLegacy(m.replyClickedId, rows);
    return ask?.answer && rows ? { ...clicksFromAnswer(rows, ask.answer.choices), ...own } : own;
  }, [m.replyClicks, m.replyClickedId, rows, ask]);
  const inline = useMemo(() => {
    const picked = inlineIds.find((id) => ask?.answer?.choices.includes(`[button:${id}]`));
    return { locked: blocked || !!picked, clicks: picked ? { [`i:${picked}`]: picked } : {}, lockHint: rows?.length ? undefined : lockHint };
  }, [inlineIds, ask, blocked, lockHint, rows]);
  // 管理 / 面板按钮行不跟 ask 锁（asks-model isMgmtRow）
  const rowLocked = (row: WebComponentRow, ri: number) => (blocked && !isMgmtRow(row)) || done.has(rowGroup(row, ri));
  const beforeSend = useCallback(
    (wire: string): boolean => {
      if (isMgmtButtonId(/^\[button:(.+)\]$/.exec(wire)?.[1] ?? "")) return true;
      if (blocked) return false;
      if (hintId) hintAskForWire(agent, wire, hintId);
      return true;
    },
    [blocked, hintId, agent],
  );
  const status = closed ? closedText(closed, t) : gone ? (expired ? t("已过期") : t("已结案")) : waiting || orphan ? lockHint : ask ? (done.size ? t("待你处理 · 已答 {n} 项", { n: done.size }) : t("待你处理")) : null;
  return { clicks, rowLocked, status, beforeSend, inline };
}
