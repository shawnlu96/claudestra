"use client";
import { useEffect, useSyncExternalStore } from "react";
import { listGuard, type GuardItem } from "@/lib/api/guard";
import type { WebStreamEvent } from "@/lib/chat/events";

/**
 * Chat Guard 待放行卡的数据（按 agent）：打开会话时拉一次 GET /guard/quarantine?agent=，之后由流里的 guard 事件增删。
 * 独立小 store（同 host-info.ts），不进 chat-store（那文件只许缩）；被拦的消息不在会话历史里，所以卡片也不混进消息列表。
 */
type GuardEvt = Extract<WebStreamEvent, { t: "guard" }>;
const byAgent = new Map<string, GuardItem[]>();
/** 发送方乐观气泡的标记：agent → 原文 → 状态（held = 等放行，dropped = 已丢弃）；放行后删掉（消息会正常进历史） */
const marks = new Map<string, Map<string, "held" | "dropped">>();
const setMark = (agent: string, text: string | undefined, status: "held" | "dropped" | null) => {
  if (!text) return;
  const m = marks.get(agent) ?? new Map<string, "held" | "dropped">();
  if (status) m.set(text, status);
  else m.delete(text);
  marks.set(agent, m);
};
const loaded = new Set<string>();
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const EMPTY: GuardItem[] = [];

export function applyGuardEvent(e: GuardEvt): void {
  const list = byAgent.get(e.agent) ?? [];
  setMark(e.agent, e.fullText, e.action === "quarantined" ? "held" : e.action === "dropped" ? "dropped" : null);
  if (e.action === "quarantined") {
    if (list.some((i) => i.id === e.id)) return;
    const hit = e.probe ? [{ id: e.probe, verdict: "block", score: e.score ?? null }] : [];
    byAgent.set(e.agent, [
      ...list,
      {
        id: e.id,
        agent: e.agent,
        from: e.from ?? "?",
        trust: e.trust ?? "unknown",
        text: e.text ?? "",
        at: e.at ?? new Date().toISOString(),
        hits: hit,
        sourceKind: "",
      },
    ]);
  } else {
    byAgent.set(
      e.agent,
      list.filter((i) => i.id !== e.id),
    );
  }
  emit();
}

export async function loadGuard(agent: string): Promise<void> {
  try {
    const items = await listGuard(agent);
    byAgent.set(agent, items);
    for (const i of items) setMark(agent, i.text, "held");
    loaded.add(agent);
    emit();
  } catch {
    /* 没权限（guest）或 bridge 旧版没有这个端点：卡片不显示即可，聊天不受影响 */
  }
}

/** 某条用户气泡（按原文逐字对）当前的守门状态；没有标记 = null */
export function useGuardMark(agent: string | undefined, text: string): "held" | "dropped" | null {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => (agent ? (marks.get(agent)?.get(text) ?? null) : null),
    () => null,
  );
}

export function removeGuardLocal(agent: string, id: string): void {
  byAgent.set(
    agent,
    (byAgent.get(agent) ?? []).filter((i) => i.id !== id),
  );
  emit();
}

export function useGuardPending(agent: string | undefined): GuardItem[] {
  useEffect(() => {
    if (agent && !loaded.has(agent)) void loadGuard(agent);
  }, [agent]);
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => (agent ? (byAgent.get(agent) ?? EMPTY) : EMPTY),
    () => EMPTY,
  );
}
