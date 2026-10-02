"use client";
/**
 * 侧栏 project 菜单的「主管 PM」主菜单项与二级页（i28-PMSW2，owner 10-03「每个项目可以切换自己的主管PM」）。
 * 外壳 / 行 / 返回项沿用 project-menu.tsx 的 MenuShell + MenuItem，跟「打开方式 → 终端 / IDE」二级页同一写法；
 * 逻辑在 project-pm-model.ts。只在有 manage 授权时出现；候选、体检、切换都走 /api/v1/projects/:id/pm。
 */
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getProjectPm, switchProjectPm, type ProjectPmView } from "@/lib/api/project-pm";
import { useT, t as tr } from "@/lib/i18n";
import { MenuItem } from "./menu-shell";
import { CheckIcon, TriangleAlertIcon, XIcon } from "./line-icons";
import { checkPm, confirmPm, pmPageRows, pmProblems, pmRows, type PmConfirm } from "./project-pm-model";

export interface ProjectPmMenu {
  view: ProjectPmView | null;
  error: string | null;
  confirm: PmConfirm | null;
  setConfirm: (c: PmConfirm | null | ((cur: PmConfirm | null) => PmConfirm | null)) => void;
  rows: number;
}

/** 菜单打开时拉一次（enabled = 有 manage 授权）；关菜单即卸载，下次打开重拉 */
export function useProjectPmMenu(project: string, enabled: boolean): ProjectPmMenu {
  const [view, setView] = useState<ProjectPmView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PmConfirm | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    getProjectPm(project).then(
      (v) => live && setView(v),
      (e: Error) => live && setError(e.message || "操作失败"),
    );
    return () => {
      live = false;
    };
  }, [project, enabled]);
  return { view, error, confirm, setConfirm, rows: pmPageRows(view, confirm) };
}

/** lucide user-cog */
function UserCogIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 15H6a4 4 0 0 0-4 4v2" />
      <path d="m14.305 16.53.923-.382" />
      <path d="m15.228 13.852-.923-.383" />
      <path d="m16.852 12.228-.383-.923" />
      <path d="m16.852 17.772-.383.924" />
      <path d="m19.148 12.228.383-.923" />
      <path d="m19.53 18.696-.382-.924" />
      <path d="m20.772 13.852.924-.383" />
      <path d="m20.772 16.148.924.383" />
      <circle cx="18" cy="15" r="3" />
      <circle cx="9" cy="7" r="4" />
    </svg>
  );
}

/** MenuItem 的禁用态：同一行样式压淡、不响应点击 */
function DisabledItem({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div aria-disabled className="pointer-events-none opacity-45">
      <MenuItem icon={icon} label={label} onClick={() => {}} />
    </div>
  );
}

/** 主菜单项「主管 PM · 当前名」，点开进二级页 */
export function PmMainItem({ pm, onClick }: { pm: ProjectPmMenu; onClick: () => void }) {
  const t = useT();
  const active = pm.view?.active;
  return <MenuItem icon={<UserCogIcon />} label={active ? `${t("主管 PM")} · ${active}` : t("主管 PM")} chevron onClick={onClick} />;
}

/** 二级页正文（返回项由 project-menu.tsx 统一画）：候选 + 确认行 + 体检问题 */
export function ProjectPmPage({ project, pm, onClose }: { project: string; pm: ProjectPmMenu; onClose: () => void }) {
  const t = useT();
  const { view, confirm, setConfirm } = pm;
  const deps = {
    post: (agent: string, dryRun: boolean) => switchProjectPm(project, agent, dryRun),
    close: onClose,
    flash: (agent: string) => flashProjectPm(tr("主管 PM 已切到 {name}", { name: agent })),
  };
  const pick = (agent: string) => {
    if (agent === view?.active) return setConfirm(null);
    setConfirm({ agent, check: "pending", problems: [] });
    void checkPm(agent, deps).then((c) => setConfirm((cur) => (cur?.agent === agent && cur.check === "pending" ? c : cur)));
  };
  const go = (agent: string) => {
    setConfirm({ agent, check: "sending", problems: [] });
    void confirmPm(agent, deps).then((c) => c && setConfirm(c));
  };
  if (!view) return <DisabledItem icon={pm.error ? <TriangleAlertIcon size={14} /> : ""} label={pm.error ? pmProblems(pm.error)[0] : t("加载中…")} />;
  return (
    <>
      {pmRows(view).map((r) => (
        <MenuItem
          key={r.name}
          icon={r.current ? <CheckIcon size={14} /> : ""}
          label={`${r.name} · ${r.runtime} · ${t(r.status)}`}
          onClick={() => pick(r.name)}
        />
      ))}
      {confirm &&
        (confirm.check === "ok" ? (
          <MenuItem icon="›" label={t("切到 {name}", { name: confirm.agent })} onClick={() => go(confirm.agent)} />
        ) : (
          <DisabledItem icon="›" label={confirm.check === "failed" ? t("切到 {name}", { name: confirm.agent }) : t("体检中…")} />
        ))}
      {confirm && <MenuItem icon={<XIcon size={14} />} label={t("取消")} onClick={() => setConfirm(null)} />}
      {confirm?.problems.map((p) => <DisabledItem key={p} icon={<TriangleAlertIcon size={14} />} label={t(p)} />)}
    </>
  );
}

// 切换成功后菜单已关，提示挂在常驻的 ProjectMenu 里；样式同气泡菜单的轻提示（bubble-menu.tsx）
const toastSubs = new Set<(s: string | null) => void>();
export function flashProjectPm(text: string): void {
  toastSubs.forEach((f) => f(text));
}

export function ProjectPmToast() {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    toastSubs.add(setText);
    return () => {
      toastSubs.delete(setText);
    };
  }, []);
  useEffect(() => {
    if (!text) return;
    const id = setTimeout(() => setText(null), 2400);
    return () => clearTimeout(id);
  }, [text]);
  if (!text || typeof document === "undefined") return null;
  return createPortal(
    <div
      role="status"
      className="pointer-events-none fixed left-1/2 z-[999] flex -translate-x-1/2 items-center gap-3 rounded-full bg-neutral px-3 py-1.5 text-xs text-neutral-content shadow-lg"
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 96px)" }}
    >
      <span>{text}</span>
    </div>,
    document.body,
  );
}
