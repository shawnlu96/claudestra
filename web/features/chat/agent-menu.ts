import type { AgentSession, ProjectMeta } from "./type";

/**
 * 侧栏会话右键 / 长按菜单的**内容**（纯函数，无 React；渲染在 components/agent-menu.tsx）。
 * 菜单项随会话状态切换：运行中 = 重启 / 停止 / 清空 / 移动到 / 归档；已停止 = 启动 / 移动到 / 归档。
 * 本机打开时（/api/host 报 local 且探测到程序）末尾再接「在 Finder 中显示 / 在终端打开 / 用 IDE 打开」，
 * project 菜单复用同一段 openItems。单测见 tests/web-agent-menu.test.ts。
 */

/** 与 lib/host/openers 的 Opener 同构；这里不 import 它（本文件要保持零依赖可测） */
export interface MenuOpener {
  id: string;
  label: string;
  kind: "files" | "terminal" | "ide";
}

export type OpenAction = `open:${string}` | "open-terminal" | "open-ide";
export type AgentMenuAction = "restart" | "kill" | "clear" | "start" | "move" | "archive" | OpenAction;

export interface AgentMenuItem {
  id: AgentMenuAction;
  /** 中文 key，渲染时过 t()；含 {app} 时用 arg 替换 */
  label: string;
  icon: string;
  danger?: boolean;
  /** 有二级菜单（移动到 ▸ / 多个终端 ▸ / 多个 IDE ▸） */
  submenu?: boolean;
  arg?: string;
}

/** 「用本机程序打开目录」的菜单项：文件管理器一项；终端 / IDE 只有一个就直达，多个进二级页。 */
export function openItems(openers: MenuOpener[], platform: string): AgentMenuItem[] {
  const out: AgentMenuItem[] = [];
  const files = openers.find((o) => o.kind === "files");
  if (files) out.push({ id: `open:${files.id}`, label: platform === "darwin" ? "在 Finder 中显示" : "打开目录", icon: "🗂" });
  const group = (kind: "terminal" | "ide", one: string, many: string, page: OpenAction, icon: string) => {
    const list = openers.filter((o) => o.kind === kind);
    if (list.length === 1) out.push({ id: `open:${list[0].id}`, label: one, icon, arg: list[0].label });
    else if (list.length > 1) out.push({ id: page, label: many, icon, submenu: true });
  };
  group("terminal", "在 {app} 中打开", "在终端打开", "open-terminal", "⌨");
  group("ide", "用 {app} 打开", "用 IDE 打开", "open-ide", "🧩");
  return out;
}

/** mock 行没有菜单；大总管只有「打开目录」类（生命周期归 launcher）→ 没有可打开的程序时也是 null。 */
export function buildAgentMenu(a: AgentSession, openers: MenuOpener[] = [], platform = "darwin"): AgentMenuItem[] | null {
  if (a.mock) return null;
  const open = openItems(openers, platform);
  if (a.pinnedMaster) return open.length ? open : null;
  const move: AgentMenuItem = { id: "move", label: "移动到", icon: "📁", submenu: true };
  const archive: AgentMenuItem = { id: "archive", label: "归档", icon: "🗄" };
  if (a.status !== "active") {
    return [{ id: "start", label: "启动", icon: "▶" }, move, archive, ...open];
  }
  return [
    { id: "restart", label: "重启", icon: "↻" },
    { id: "kill", label: "停止", icon: "⏻", danger: true },
    // 清空放最下的生命周期项（顶栏菜单同款理由：破坏性最低但最常误触）
    { id: "clear", label: "清空", icon: "⌫" },
    move,
    archive,
    ...open,
  ];
}

/** 「移动到」的候选：除当前所属外的全部 project，按显示名排序，稳定可测。 */
export function moveTargets(a: AgentSession, projects: ProjectMeta[]): ProjectMeta[] {
  return projects
    .filter((p) => p.id !== (a.projectId ?? ""))
    .slice()
    .sort((x, y) => (x.name || x.id).localeCompare(y.name || y.id, "zh-Hans-CN"));
}
