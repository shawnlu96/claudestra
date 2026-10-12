"use client";
import { useEffect, useSyncExternalStore } from "react";
import { listGuard, type GuardItem } from "@/lib/api/guard";
import type { WebStreamEvent } from "@/lib/chat/events";
import { machines } from "@/lib/machines";
import { createGuardMarks } from "./guard-marks";

/**
 * Chat Guard 待放行卡的数据（按 agent）：打开会话时拉一次 GET /guard/quarantine?agent=，之后由流里的 guard 事件增删。
 * 独立小 store（同 host-info.ts），不进 chat-store（那文件只许缩）；被拦的消息不在会话历史里，所以卡片也不混进消息列表。
 * 卡片用的 guard 事件只发给 manage 设备、且只带预览：新卡先标 partial，随即重拉清单取全文，取到之前不许放行（看不全就放行 = 批准没看过的内容）。
 * 发件人自己（含 guest）另收不带正文的 self 事件，只更新自己气泡的标记（guard-marks.ts）。
 * 全按 agent 名记，而 agent 名在别的机器上会重名：切机器整份清空、作废在途拉取，新机器打开会话时重拉（tests/web-guard-store.test.ts）。
 */
type GuardEvt = Extract<WebStreamEvent, { t: "guard" }>;
const byAgent = new Map<string, GuardItem[]>();
/** 本端乐观气泡的守门状态（held = 等放行，dropped = 已丢弃；放行后消掉，消息会正常进历史） */
let marks = createGuardMarks();
const loaded = new Set<string>();
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (cb: () => void) => {
  subs.add(cb);
  return () => void subs.delete(cb);
};
const EMPTY: GuardItem[] = [];
/** 切机器计数：拉取发出时记下，回来时变了 = 旧机器的清单，不落进新机器 */
let machineGen = 0;
machines.onSwitch(() => {
  machineGen++;
  byAgent.clear();
  loaded.clear();
  marks = createGuardMarks();
  emit();
});

/** 发送接口回了 guarded：这条没进 agent，给本端气泡打「等放行」 */
export function noteGuardedSend(messageId: string | undefined, bubbleId: string): void {
  marks.sent(messageId, bubbleId);
  emit();
}

export function applyGuardEvent(e: GuardEvt): void {
  marks.event(e.id, e.action);
  if (e.self) return emit(); // 发件人的状态事件：只动气泡标记，卡片归 manage 设备
  const list = byAgent.get(e.agent) ?? [];
  if (e.action === "quarantined") {
    if (list.some((i) => i.id === e.id)) return emit();
    const hit = e.probe ? [{ id: e.probe, verdict: "block", score: e.score ?? null }] : [];
    const item: GuardItem = {
      id: e.id, agent: e.agent, from: e.from ?? "?", trust: e.trust ?? "unknown", text: e.text ?? "", at: e.at ?? new Date().toISOString(),
      hits: hit, sourceKind: "", partial: true,
    };
    byAgent.set(e.agent, [...list, item]);
    void loadGuard(e.agent); // 取全文
  } else {
    byAgent.set(
      e.agent,
      list.filter((i) => i.id !== e.id),
    );
  }
  emit();
}

export async function loadGuard(agent: string): Promise<void> {
  const gen = machineGen;
  try {
    const items = await listGuard(agent);
    if (gen !== machineGen) return;
    byAgent.set(agent, items);
    loaded.add(agent);
    emit();
  } catch {
    /* 没权限（guest）或 bridge 旧版没有这个端点：卡片不显示即可，聊天不受影响 */
  }
}

/** 某条用户气泡（按气泡 id）当前的守门状态；没有标记 = null */
export const guardMarkOf = (id: string): "held" | "dropped" | null => marks.of(id);

export function useGuardMark(id: string): "held" | "dropped" | null {
  return useSyncExternalStore(subscribe, () => guardMarkOf(id), () => null);
}

export function removeGuardLocal(agent: string, id: string): void {
  byAgent.set(
    agent,
    (byAgent.get(agent) ?? []).filter((i) => i.id !== id),
  );
  emit();
}

/** 某 agent 当前的待放行卡（没拉过 / 刚切机器 = 空） */
export function guardPendingOf(agent: string | undefined): GuardItem[] {
  return agent ? (byAgent.get(agent) ?? EMPTY) : EMPTY;
}

export function useGuardPending(agent: string | undefined): GuardItem[] {
  const gen = useSyncExternalStore(subscribe, () => machineGen, () => 0); // 切机器后同名会话也要重拉
  useEffect(() => {
    if (agent && !loaded.has(agent)) void loadGuard(agent);
  }, [agent, gen]);
  return useSyncExternalStore(subscribe, () => guardPendingOf(agent), () => EMPTY);
}
