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
const loaded = new Set<string>();
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const EMPTY: GuardItem[] = [];

export function applyGuardEvent(e: GuardEvt): void {
  const list = byAgent.get(e.agent) ?? [];
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
    byAgent.set(agent, await listGuard(agent));
    loaded.add(agent);
    emit();
  } catch {
    /* 没权限（guest）或 bridge 旧版没有这个端点：卡片不显示即可，聊天不受影响 */
  }
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
