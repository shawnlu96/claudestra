"use client";
/**
 * 侧栏会话的右键 / 长按菜单（owner 2026-09-23「建立关于对话的右键菜单」）。
 * 手势与气泡菜单同款（bubble-menu.tsx）：桌面右键、触摸端长按 450ms，portal 到 body、
 * fixed 定位在指针旁，不进文档流；手指挪动 >12px 视为滚动 / 左滑，计时器作废，
 * 所以与行的左滑手势互不干扰。菜单内容由 ../agent-menu.ts 决定（纯函数，可测）。
 * 「移动到」「在终端打开」「用 IDE 打开」都是同一浮层内的二级页，不另开子浮层——手机上够点。
 * 外壳（定位 / 遮罩 / 行）在 menu-shell.tsx，与 project 菜单共用。
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useCloseOnNavigate, useLongPressMenu } from "./menu-gestures";
import { MenuItem, MenuShell, menuLabel } from "./menu-shell";
import { useChatStore, useChatStoreApi } from "../chat-store";
import { buildAgentMenu, moveTargets, type AgentMenuAction } from "../agent-menu";
import { assignAgentProject } from "../project-actions";
import { openLocal, useHostInfo, type Opener } from "../host-info";
import type { AgentSession, ProjectMeta } from "../type";
import { useT } from "@/lib/i18n";
import { useArmedConfirm } from "../use-armed-confirm";
import { ClearAgentModal } from "./clear-agent-modal";

type MenuState = { agent: AgentSession; x: number; y: number } | null;
type Page = "main" | "move" | "open-terminal" | "open-ide";
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

/** 二级页：某一类打开方式的列表（终端 / IDE） */
function OpenerList({ openers, onPick }: { openers: Opener[]; onPick: (id: string) => void }) {
  return (
    <>
      {openers.map((o) => (
        <MenuItem key={o.id} icon="›" label={o.label} onClick={() => onPick(o.id)} />
      ))}
    </>
  );
}

/** 浮层本体：主页（生命周期 + 移动到 + 归档 + 打开目录）/ 二级页（project 列表、终端、IDE）。 */
function MenuPanel({ s, page, targets, openers, platform, onAction, onMove, onBack }: {
  s: NonNullable<MenuState>;
  page: Page;
  targets: ProjectMeta[];
  openers: Opener[];
  platform: string;
  onAction: (id: AgentMenuAction) => void;
  onMove: (p: ProjectMeta) => void;
  onBack: () => void;
}) {
  const t = useT();
  // 归档要二次确认（owner 2026-09-24）：点一下变「确认归档?」，4s 没再点自动复原；菜单关了状态随之消失
  const arch = useArmedConfirm(4000);
  const items = buildAgentMenu(s.agent, openers, platform) ?? [];
  const sub = page === "open-terminal" ? openers.filter((o) => o.kind === "terminal") : page === "open-ide" ? openers.filter((o) => o.kind === "ide") : [];
  const rows = page === "main" ? items.length : 1 + Math.max(1, page === "move" ? targets.length : sub.length);
  const title = page === "move" ? t("移动到") : page === "open-terminal" ? t("在终端打开") : page === "open-ide" ? t("用 IDE 打开") : s.agent.displayName;
  return (
    <MenuShell x={s.x} y={s.y} rows={rows} title={title} onClose={closeAgentMenu}>
      {page === "main" &&
        items.map((it) =>
          it.id === "archive" ? (
            <MenuItem
              key={it.id}
              icon={it.icon}
              label={arch.armed ? t("确认归档?") : t(it.label)}
              danger={arch.armed}
              onClick={() => (arch.armed ? onAction("archive") : arch.arm())}
            />
          ) : (
            <MenuItem key={it.id} icon={it.icon} label={menuLabel(t, it.label, it.arg)} danger={it.danger} chevron={it.submenu} onClick={() => onAction(it.id)} />
          ),
        )}
      {page !== "main" && <MenuItem icon="‹" label={t("返回")} onClick={onBack} />}
      {page === "move" && targets.length === 0 && (
        <div className="px-3.5 py-2 text-[12.5px] text-base-content/40">{t("没有别的 project")}</div>
      )}
      {page === "move" && targets.map((p) => <MenuItem key={p.id} icon={p.emoji || "📁"} label={p.name || p.id} onClick={() => onMove(p)} />)}
      {(page === "open-terminal" || page === "open-ide") && <OpenerList openers={sub} onPick={(id) => onAction(`open:${id}`)} />}
    </MenuShell>
  );
}

/** 单实例菜单，挂一份在 Sidebar 里即可。 */
export function AgentMenu() {
  const t = useT();
  const store = useChatStoreApi();
  const projects = useChatStore((st) => st.state.projects);
  const host = useHostInfo();
  const [s, setS] = useState<MenuState>(null);
  const [page, setPage] = useState<Page>("main");
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
    if (id === "move" || id === "open-terminal" || id === "open-ide") {
      setPage(id);
      return;
    }
    closeAgentMenu();
    if (id.startsWith("open:")) void openLocal("agent", name, id.slice(5)).then((r) => fail("打开失败:", r));
    else if (id === "clear") setClearFor(s.agent);
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
        <MenuPanel
          s={s}
          page={page}
          targets={moveTargets(s.agent, projects)}
          openers={host.openers}
          platform={host.platform}
          onAction={onAction}
          onMove={onMove}
          onBack={() => setPage("main")}
        />
      )}
      {clearFor && <ClearAgentModal agent={clearFor} onClose={() => setClearFor(null)} />}
    </>,
    document.body,
  );
}
