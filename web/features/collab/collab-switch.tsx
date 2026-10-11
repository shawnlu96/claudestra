"use client";
import { SharedCollabContent } from "./dag/shared-navigation";
export { closingCollab } from "./dag/shared-closing";
export { CollabSidebarGate } from "./collab-sidebar";
/**
 * 协作视图挂在会话主区域上面的一层（main 里一行 <CollabSwitch />）：打开时盖住聊天，聊天在底下照常挂着，
 * 关掉就是原来的会话、不用重载。点侧栏任何会话都先关掉它（closingCollab 包住 Sidebar 的 onSelect）。
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { markRead } from "../chat/scoped-requests";
import { machines } from "@/lib/machines";
import { useChatStore, useChatStoreApi } from "../chat/chat-store";
import { CollabPaneBoundary } from "@/components/boundaries";
import { CollabView } from "./collab-view";
import { closeCollab, takeReleasedReads, useCollabNav } from "./collab-nav";
import { CollabSidebarRail } from "./collab-sidebar";

const subscribeMachines = (cb: () => void) => machines.subscribe(cb);
const currentFp = () => machines.currentFp();
const noFp = () => null;

/** 关掉协作视图后等会话切换落定（侧栏点会话是双 rAF 后才 openAgent）再判断停在哪个会话 */
const SETTLE_MS = 400;

export function CollabSwitch() {
  const { project } = useCollabNav();
  const store = useChatStoreApi();
  // 会话从别处换了（通知直达、深链、⌘K）：别让它被盖在协作视图底下
  const active = useChatStore((st) => st.state.activeAgent);
  const seen = useRef(active);
  useEffect(() => {
    if (seen.current !== active) closeCollab();
    seen.current = active;
  }, [active]);
  // 切机器（哪怕没选中会话）：协作视图是上一台机器的台账，收起来；此刻动作 / 推进记录随组件卸载一起清掉
  const fp = useSyncExternalStore(subscribeMachines, currentFp, noFp);
  const seenFp = useRef(fp);
  useEffect(() => {
    if (seenFp.current !== fp) closeCollab();
    seenFp.current = fp;
  }, [fp]);
  // 收起后如果停在的正是盖着期间被拦下已读的那个会话，替它补一次（markActiveRead 有 5s 节流，被吞的那次已经占了额度）
  useEffect(() => {
    if (project) return;
    const held = takeReleasedReads();
    if (!held.length) return;
    const timer = setTimeout(() => {
      const cur = store.state.activeAgent;
      if (cur && held.includes(cur)) void markRead(cur).catch(() => undefined); // 失败无感：下一次打开 / 看着时收到回复会再补
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [project, store]);
  if (!project) return null;
  return (
    <div className="absolute inset-0 z-[45] flex bg-base-100">
      <CollabSidebarRail />
      <CollabPaneBoundary key={project} onClose={closeCollab}>
        <SharedCollabContent project={project} fallback={<CollabView project={project} />} />
      </CollabPaneBoundary>
    </div>
  );
}
