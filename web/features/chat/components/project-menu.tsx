"use client";
/**
 * 侧栏 project 组头的右键 / 长按菜单（owner 2026-09-25「在会话 / 项目右键能执行类似 Reveal in Finder」）。
 * 目前只有「打开目录」一类项：文件管理器 / 终端 / IDE，内容复用 ../agent-menu.ts 的 openItems；
 * project 有多个目录时先选目录（二级页）。只在 /api/host 报本机且探测到程序时出现（组头不挂手势）。
 * 手势、外壳与会话菜单同款（menu-gestures.ts / menu-shell.tsx）。
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useCloseOnNavigate, useLongPressMenu } from "./menu-gestures";
import { MenuItem, MenuShell, menuLabel } from "./menu-shell";
import { openItems, type AgentMenuAction } from "../agent-menu";
import { openLocal, useHostInfo, type Opener } from "../host-info";
import type { ProjectMeta } from "../type";
import { useT } from "@/lib/i18n";

type MenuState = { p: ProjectMeta; x: number; y: number } | null;
type Page = { kind: "main" } | { kind: "list"; group: "terminal" | "ide" } | { kind: "dirs"; target: string };
const subs = new Set<(s: MenuState) => void>();
function emit(s: MenuState) {
  subs.forEach((f) => f(s));
}
export function closeProjectMenu(): void {
  emit(null);
}

/** 挂在组头上的触发器；consumedClick() 让长按松手时的 click 不再切换折叠。 */
export function useProjectMenuTrigger(get: () => ProjectMeta, enabled: boolean) {
  return useLongPressMenu({ enabled, open: (x, y) => emit({ p: get(), x, y }) });
}

function baseName(dir: string): string {
  return dir.replace(/\/+$/, "").split("/").pop() || dir;
}

function ProjectPanel({ s, openers, platform }: { s: NonNullable<MenuState>; openers: Opener[]; platform: string }) {
  const t = useT();
  const [page, setPage] = useState<Page>({ kind: "main" });
  const dirs = s.p.dirs ?? [];
  const items = openItems(openers, platform);
  const list = page.kind === "list" ? openers.filter((o) => o.kind === page.group) : [];
  const rows = page.kind === "main" ? items.length : 1 + Math.max(1, page.kind === "list" ? list.length : dirs.length);
  const title = page.kind === "dirs" ? t("选择目录") : page.kind === "list" ? t(page.group === "terminal" ? "在终端打开" : "用 IDE 打开") : s.p.name || s.p.id;
  // 选定程序后：单目录直接开，多目录进目录页
  const pick = (target: string) => {
    if (dirs.length > 1) {
      setPage({ kind: "dirs", target });
      return;
    }
    closeProjectMenu();
    void openLocal("project", s.p.id, target, 0).then((r) => {
      if (!r.ok) alert(`${t("打开失败:")}${t(r.error || "操作失败")}`);
    });
  };
  const onMain = (id: AgentMenuAction) => {
    if (id === "open-terminal") setPage({ kind: "list", group: "terminal" });
    else if (id === "open-ide") setPage({ kind: "list", group: "ide" });
    else if (id.startsWith("open:")) pick(id.slice(5));
  };
  const openDir = (index: number) => {
    if (page.kind !== "dirs") return;
    closeProjectMenu();
    void openLocal("project", s.p.id, page.target, index).then((r) => {
      if (!r.ok) alert(`${t("打开失败:")}${t(r.error || "操作失败")}`);
    });
  };
  return (
    <MenuShell x={s.x} y={s.y} rows={rows} title={title} onClose={closeProjectMenu}>
      {page.kind === "main" &&
        items.map((it) => <MenuItem key={it.id} icon={it.icon} label={menuLabel(t, it.label, it.arg)} chevron={it.submenu} onClick={() => onMain(it.id)} />)}
      {page.kind !== "main" && <MenuItem icon="‹" label={t("返回")} onClick={() => setPage({ kind: "main" })} />}
      {page.kind === "list" && list.map((o) => <MenuItem key={o.id} icon="›" label={o.label} onClick={() => pick(o.id)} />)}
      {page.kind === "dirs" && dirs.map((d, i) => <MenuItem key={d} icon="📁" label={baseName(d)} onClick={() => openDir(i)} />)}
    </MenuShell>
  );
}

/** 单实例菜单，挂一份在 Sidebar 里即可。 */
export function ProjectMenu() {
  const host = useHostInfo();
  const [s, setS] = useState<MenuState>(null);
  useEffect(() => {
    subs.add(setS);
    return () => {
      subs.delete(setS);
    };
  }, []);
  useCloseOnNavigate(closeProjectMenu);
  if (typeof document === "undefined" || !s) return null;
  // key 随打开的 project 变：重开时 page 回到主页
  return createPortal(<ProjectPanel key={`${s.p.id}:${s.x}:${s.y}`} s={s} openers={host.openers} platform={host.platform} />, document.body);
}
