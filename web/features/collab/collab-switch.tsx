"use client";
/**
 * 协作视图挂在会话主区域上面的一层（main 里一行 <CollabSwitch />）：打开时盖住聊天，聊天在底下照常挂着，
 * 关掉就是原来的会话、不用重载。点侧栏任何会话都先关掉它（closingCollab 包住 Sidebar 的 onSelect）。
 */
import { useEffect, useRef } from "react";
import { useChatStore } from "../chat/chat-store";
import { CollabView } from "./collab-view";
import { closeCollab, useCollabNav } from "./collab-nav";

export function CollabSwitch() {
  const { project } = useCollabNav();
  // 会话从别处换了（通知直达、深链、⌘K）：别让它被盖在协作视图底下
  const active = useChatStore((st) => st.state.activeAgent);
  const seen = useRef(active);
  useEffect(() => {
    if (seen.current !== active) closeCollab();
    seen.current = active;
  }, [active]);
  if (!project) return null;
  return (
    // z-[45]：盖过会话顶栏（z-40），低于弹窗（z-50）与启动页（z-60）
    <div className="absolute inset-0 z-[45] flex bg-base-100">
      <CollabView key={project} project={project} />
    </div>
  );
}

const wrapped = new WeakMap<() => void, () => void>();
/** 同一个 fn 永远包出同一个函数：Sidebar 的 onSelect 引用不变，不为这个多一次重渲 */
export function closingCollab(fn: () => void): () => void {
  let w = wrapped.get(fn);
  if (!w) {
    w = () => {
      closeCollab();
      fn();
    };
    wrapped.set(fn, w);
  }
  return w;
}
