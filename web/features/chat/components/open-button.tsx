"use client";
import { useT } from "@/lib/i18n";
import type { AgentSession } from "../type";
import { openLocal, useHostInfo } from "../host-info";
import { menuLabel } from "./menu-shell";
import { closeDropdown } from "./agent-actions";

/** 打开目录：lucide folder-open */
function FolderOpenIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

/**
 * 会话顶栏的「打开」下拉（owner 2026-09-25「在会话详情顶部的 header 上，增加一个 Open 图标，点击是下拉菜单」）：
 * 当前会话的工作目录用本机程序打开——文件管理器一项，终端 / IDE 各一组平铺（下拉里不做二级页）。
 * 只在 /api/host 报本机且探测到程序时渲染；数据与侧栏右键菜单同源（features/chat/host-info.ts）。
 * daisyUI focus 模式下拉，与 ⋮ 菜单同款，选项点击后 blur 收起。
 */
export function OpenButton({ agent }: { agent: AgentSession }) {
  const t = useT();
  const host = useHostInfo();
  if (agent.mock || host.openers.length === 0) return null;
  const files = host.openers.filter((o) => o.kind === "files");
  const terminals = host.openers.filter((o) => o.kind === "terminal");
  const ides = host.openers.filter((o) => o.kind === "ide");
  const pick = (id: string) => () => {
    closeDropdown();
    void openLocal("agent", agent.name, id).then((r) => {
      if (!r.ok) alert(`${t("打开失败:")}${t(r.error || "操作失败")}`);
    });
  };
  return (
    <div className="dropdown dropdown-end">
      <div tabIndex={0} role="button" aria-label={t("打开目录")} title={t("打开目录")} className="btn btn-ghost btn-sm px-2 text-base-content/60 hover:text-base-content">
        <FolderOpenIcon />
      </div>
      <ul tabIndex={0} className="dropdown-content menu z-50 mt-1 w-52 rounded-box border border-base-300 bg-base-100 p-1 shadow-lg">
        {files.map((o) => (
          <li key={o.id}>
            <button onClick={pick(o.id)}>{t(host.platform === "darwin" ? "在 Finder 中显示" : "打开目录")}</button>
          </li>
        ))}
        {terminals.length > 0 && <li className="menu-title">{t("终端")}</li>}
        {terminals.map((o) => (
          <li key={o.id}>
            <button onClick={pick(o.id)}>{menuLabel(t, "在 {app} 中打开", o.label)}</button>
          </li>
        ))}
        {ides.length > 0 && <li className="menu-title">IDE</li>}
        {ides.map((o) => (
          <li key={o.id}>
            <button onClick={pick(o.id)}>{menuLabel(t, "用 {app} 打开", o.label)}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
