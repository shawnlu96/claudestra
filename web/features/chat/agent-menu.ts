import type { AgentSession, ProjectMeta } from "./type";

/**
 * 侧栏会话右键 / 长按菜单的**内容**（纯函数，无 React；渲染在 components/agent-menu.tsx）。
 * 菜单项随会话状态切换：运行中 = 重启 / 停止 / 清空 / 移动到 / 归档；已停止 = 启动 / 移动到 / 归档。
 * 单测见 tests/web-agent-menu.test.ts。
 */

export type AgentMenuAction = "restart" | "kill" | "clear" | "start" | "move" | "archive";

export interface AgentMenuItem {
  id: AgentMenuAction;
  /** 中文 key，渲染时过 t() */
  label: string;
  icon: string;
  danger?: boolean;
  /** 有二级菜单（移动到 ▸） */
  submenu?: boolean;
}

/** 大总管 / mock 行没有菜单（生命周期归 launcher；mock 无后端）→ null。 */
export function buildAgentMenu(a: AgentSession): AgentMenuItem[] | null {
  if (a.pinnedMaster || a.mock) return null;
  const move: AgentMenuItem = { id: "move", label: "移动到", icon: "📁", submenu: true };
  const archive: AgentMenuItem = { id: "archive", label: "归档", icon: "🗄" };
  if (a.status !== "active") {
    return [{ id: "start", label: "启动", icon: "▶" }, move, archive];
  }
  return [
    { id: "restart", label: "重启", icon: "↻" },
    { id: "kill", label: "停止", icon: "⏻", danger: true },
    // 清空放最下的生命周期项（顶栏菜单同款理由：破坏性最低但最常误触）
    { id: "clear", label: "清空", icon: "⌫" },
    move,
    archive,
  ];
}

/** 「移动到」的候选：除当前所属外的全部 project，按显示名排序，稳定可测。 */
export function moveTargets(a: AgentSession, projects: ProjectMeta[]): ProjectMeta[] {
  return projects
    .filter((p) => p.id !== (a.projectId ?? ""))
    .slice()
    .sort((x, y) => (x.name || x.id).localeCompare(y.name || y.id, "zh-Hans-CN"));
}
