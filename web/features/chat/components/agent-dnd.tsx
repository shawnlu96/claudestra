"use client";
import { useState } from "react";
import { useChatStoreApi } from "../chat-store";
import { assignAgentProject } from "../project-actions";
import { DND_MIME, beginAgentDrag, currentDrag, dropTarget, endAgentDrag, type DragAgent } from "../sidebar-dnd";
import { useT } from "@/lib/i18n";

/**
 * 侧栏拖拽改 project 的 DOM 接线（判定在 ../sidebar-dnd.ts）。
 * - 拖：agent 行 `draggable`，dataTransfer 只放自家 MIME + 名字；
 * - 放：project 组头 / 别的 agent 行；悬停高亮，松手 assign → 拉一遍 projects + agents，
 *   侧栏分组随之重排（列表指纹含 projectId）。
 * 仅桌面端（sm+ 才给 draggable）；手机端改 project 走长按菜单「移动到」。
 */

/** 只在鼠标设备上给 draggable：iOS 15+ 的 draggable 元素长按会起原生拖拽，跟长按菜单打架。 */
export function dragAllowed(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

/** 挂在 agent 行上：让它可拖。 */
export function dragHandlers(d: DragAgent) {
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(DND_MIME, d.name);
      e.dataTransfer.effectAllowed = "move";
      beginAgentDrag(d);
    },
    onDragEnd: () => endAgentDrag(),
  };
}

/** 挂在放置目标上：返回悬停态 + handlers。target 同 dropTarget 的第二参。 */
export function useAgentDrop(target: { projectId?: string | null; agentName?: string }) {
  const store = useChatStoreApi();
  const t = useT();
  const [over, setOver] = useState(false);
  const accept = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DND_MIME)) return null;
    return dropTarget(currentDrag(), target);
  };
  return {
    over,
    handlers: {
      onDragOver: (e: React.DragEvent) => {
        const pid = accept(e);
        if (!pid) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => {
        setOver(false);
        const pid = accept(e);
        const d = currentDrag();
        if (!pid || !d) return;
        e.preventDefault();
        endAgentDrag();
        void assignAgentProject(d.name, pid).then((r) => {
          if (!r.ok) {
            alert(`${t("移动失败:")}${t(r.error || "操作失败")}`);
            return;
          }
          void store.loadProjects();
          void store.refreshAgents();
        });
      },
    },
  };
}
