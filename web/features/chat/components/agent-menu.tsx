"use client";
/**
 * 侧栏会话的右键 / 长按菜单（owner 2026-09-23「建立关于对话的右键菜单」）。
 * 手势与气泡菜单同款（bubble-menu.tsx）：桌面右键、触摸端长按 450ms，portal 到 body、
 * fixed 定位在指针旁，不进文档流；手指挪动 >12px 视为滚动 / 左滑，计时器作废，
 * 所以与行的左滑手势互不干扰。菜单内容由 ../agent-menu.ts 决定（纯函数，可测）。
 * 「移动到」是同一浮层内的二级页（列出别的 project），不另开子浮层——手机上够点。
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useCloseOnNavigate, useLongPressMenu } from "./menu-gestures";
import { useChatStore, useChatStoreApi } from "../chat-store";
import { buildAgentMenu, moveTargets, type AgentMenuAction } from "../agent-menu";
import { assignAgentProject } from "../project-actions";
import type { AgentSession, ProjectMeta } from "../type";
import { useT } from "@/lib/i18n";
import { useArmedConfirm } from "../use-armed-confirm";
import { ClearAgentModal } from "./clear-agent-modal";

const MENU_W = 200;
const ROW_H = 40;

type MenuState = { agent: AgentSession; x: number; y: number } | null;
const subs = new Set<(s: MenuState) => void>();
function emit(s: MenuState) {
  subs.forEach((f) => f(s));
}
export function closeAgentMenu(): void {
  emit(null);
}

/** 挂在会话行上的触发器；consumedClick() 让长按松手时的 click 不再进会话。 */
export function useAgentMenuTrigger(get: () => AgentSession, enabled: boolean) {
  return useLongPressMenu({ enabled, open: (x, y) => emit({ agent: get(), x, y }) });
}

function Item({ icon, label, onClick, danger, chevron }: { icon: string; label: string; onClick: () => void; danger?: boolean; chevron?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[13.5px] active:bg-base-300 hover:bg-base-200 ${
        danger ? "text-error" : "text-base-content/85"
      }`}
      onClick={onClick}
    >
      <span className="w-4 shrink-0 text-center opacity-70">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {chevron && <span className="shrink-0 text-[11px] opacity-40">▸</span>}
    </button>
  );
}

/** 浮层本体：主页（生命周期 + 移动到 + 归档）/ 二级页（project 列表）。 */
function MenuPanel({ s, page, targets, onAction, onMove, onBack }: {
  s: NonNullable<MenuState>;
  page: "main" | "move";
  targets: ProjectMeta[];
  onAction: (id: AgentMenuAction) => void;
  onMove: (p: ProjectMeta) => void;
  onBack: () => void;
}) {
  const t = useT();
  // 归档要二次确认（owner 2026-09-24）：点一下变「确认归档?」，4s 没再点自动复原；菜单关了状态随之消失
  const arch = useArmedConfirm(4000);
  const items = buildAgentMenu(s.agent) ?? [];
  const rows = page === "main" ? items.length : 1 + Math.max(1, targets.length);
  const h = rows * ROW_H + 30;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.min(Math.max(8, s.x - 12), vw - MENU_W - 8);
  const below = s.y + 10;
  const top = below + h < vh - 8 ? below : Math.max(8, s.y - h - 10);
  return (
    <>
      <div className="fixed inset-0 z-[997]" style={{ touchAction: "none" }} onPointerDown={() => closeAgentMenu()} />
      <div
        role="menu"
        className="cstra-menu-in fixed z-[998] overflow-hidden rounded-2xl border border-base-300 bg-base-100/97 py-1.5 shadow-xl backdrop-blur"
        style={{ left, top, width: MENU_W }}
      >
        <div className="truncate px-3.5 pb-1 pt-0.5 text-[11px] text-base-content/40">
          {page === "move" ? t("移动到") : s.agent.displayName}
        </div>
        {page === "main" &&
          items.map((it) =>
            it.id === "archive" ? (
              <Item
                key={it.id}
                icon={it.icon}
                label={arch.armed ? t("确认归档?") : t(it.label)}
                danger={arch.armed}
                onClick={() => (arch.armed ? onAction("archive") : arch.arm())}
              />
            ) : (
              <Item key={it.id} icon={it.icon} label={t(it.label)} danger={it.danger} chevron={it.submenu} onClick={() => onAction(it.id)} />
            ),
          )}
        {page === "move" && (
          <>
            <Item icon="‹" label={t("返回")} onClick={onBack} />
            {targets.length === 0 && (
              <div className="px-3.5 py-2 text-[12.5px] text-base-content/40">{t("没有别的 project")}</div>
            )}
            {targets.map((p) => (
              <Item key={p.id} icon={p.emoji || "📁"} label={p.name || p.id} onClick={() => onMove(p)} />
            ))}
          </>
        )}
      </div>
    </>
  );
}

/** 单实例菜单，挂一份在 Sidebar 里即可。 */
export function AgentMenu() {
  const t = useT();
  const store = useChatStoreApi();
  const projects = useChatStore((st) => st.state.projects);
  const [s, setS] = useState<MenuState>(null);
  const [page, setPage] = useState<"main" | "move">("main");
  const [clearFor, setClearFor] = useState<AgentSession | null>(null);
  useEffect(() => {
    const on = (v: MenuState) => {
      setS(v);
      setPage("main");
    };
    subs.add(on);
    return () => {
      subs.delete(on);
    };
  }, []);
  useCloseOnNavigate(closeAgentMenu);

  const fail = (what: string, r: { ok?: boolean; error?: string }) => {
    if (!r.ok) alert(`${t(what)}${t(r.error || "操作失败")}`);
  };
  // 菜单点完即收；结果靠列表轮询体现（重启 10-40s，不在浮层上转圈）。失败才 alert，
  // 与行左滑的归档 / 删除同款。
  const onAction = (id: AgentMenuAction) => {
    if (!s) return;
    const name = s.agent.name;
    if (id === "move") {
      setPage("move");
      return;
    }
    closeAgentMenu();
    if (id === "clear") setClearFor(s.agent);
    else if (id === "kill") void store.killAgent(name).then((r) => fail("停止失败:", r));
    else if (id === "archive") void store.archiveAgent(name).then((r) => fail("归档失败:", r));
    else void store.restartAgent(name).then((r) => fail(id === "start" ? "启动失败:" : "重启失败:", r));
  };
  const onMove = (p: ProjectMeta) => {
    if (!s) return;
    const name = s.agent.name;
    closeAgentMenu();
    void assignAgentProject(name, p.id).then((r) => {
      fail("移动失败:", r);
      if (!r.ok) return;
      void store.loadProjects();
      void store.refreshAgents();
    });
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <>
      {s && (
        <MenuPanel s={s} page={page} targets={moveTargets(s.agent, projects)} onAction={onAction} onMove={onMove} onBack={() => setPage("main")} />
      )}
      {clearFor && <ClearAgentModal agent={clearFor} onClose={() => setClearFor(null)} />}
    </>,
    document.body,
  );
}
