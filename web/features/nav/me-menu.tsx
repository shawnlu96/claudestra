"use client";
/**
 * 「我的」（NAVBAR1）：电脑是图标栏底部的按钮 + 弹出菜单（外壳沿用侧栏行操作菜单 menu-shell.tsx），手机是底部栏「我的」那一页。
 * 条目都来自 me-entries.ts 那一张表；点了调原来的打开动作——设置 / 伙伴机器 / 用量 / 项目管理 / 多选的状态仍归 Sidebar，由它把回调原样传进来。
 * 新终端、图片与文件的面板由各自的 hook 管（shell-button.tsx / media-button.tsx），useMeItems 把面板节点交给调用方常挂。
 */
import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFullScope } from "../chat/contacts-data";
import { usePeerOnline } from "../chat/components/contacts-lines";
import { MenuShell } from "../chat/components/menu-shell";
import { useReadAll } from "../chat/components/sidebar-read-all";
import { useMediaEntry } from "../media/media-button";
import { useShellEntry } from "../terminal/shell-button";
import type { VersionInfo } from "@/lib/api/version";
import { meEntries, type MeEntry, type MeId } from "./me-entries";
import { MeIcon, NavIcon } from "./nav-icons";
import { useNavT } from "./use-nav-t";
import { setTab } from "./nav-tab";

/** Sidebar 持有的那组状态与回调（原来传给顶栏管理按钮的同一组，外加设置） */
export interface MeActions {
  manage: boolean;
  onSettings: () => void;
  onProjects: () => void;
  onToggleManage: () => void;
  onPeers: () => void;
  onStats: () => void;
}

export interface MeItem extends MeEntry {
  /** 右侧状态字（伙伴机器的「n/total 在线」） */
  status: string | null;
  run: () => void;
}

/** 条目 + 动作；node = 终端 / 图片面板，调用方常挂（菜单收起、手机切走页面后面板还要在） */
export function useMeItems(a: MeActions): { items: MeItem[]; node: ReactNode } {
  const tr = useNavT();
  const full = useFullScope() === true;
  const shell = useShellEntry(), media = useMediaEntry(), readAll = useReadAll();
  const peers = usePeerOnline();
  const runs: Record<MeId, () => void> = {
    settings: a.onSettings,
    readAll: () => void readAll.clear(),
    projectAdmin: a.onProjects,
    // 多选的勾选框在会话列表里：手机从「我的」页进多选要先回到「会话」
    manage: () => {
      if (!a.manage) setTab("sessions");
      a.onToggleManage();
    },
    peers: a.onPeers,
    stats: a.onStats,
    shell: shell.open,
    media: media.open,
  };
  const items = meEntries({ full, shell: shell.available, manage: a.manage }).map((e) => ({
    ...e,
    label: tr(e.label),
    status: e.id === "peers" && peers ? tr("{n}/{total} 在线", { n: peers.online, total: peers.total }) : null,
    run: runs[e.id],
  }));
  return { items, node: <>{shell.node}{media.node}</> };
}

const ROW = "flex w-full items-center gap-2.5 text-left text-base-content/85 hover:bg-base-200 active:bg-base-300";

function ItemRow({ it, onDone, big }: { it: MeItem; onDone?: () => void; big?: boolean }) {
  return (
    <button type="button" role={big ? undefined : "menuitem"} className={`${ROW} ${big ? "rounded-xl px-3 py-3 text-[15px]" : "px-3.5 py-2.5 text-[13.5px]"}`}
      data-me-entry={it.id} onClick={() => { onDone?.(); it.run(); }}>
      <span className="flex w-5 shrink-0 justify-center opacity-70"><MeIcon name={it.icon} size={big ? 18 : 16} /></span>
      <span className="min-w-0 flex-1 truncate">{it.label}</span>
      {it.status && <span className="shrink-0 text-[12px] tabular-nums text-base-content/50" data-me-status>{it.status}</span>}
    </button>
  );
}

/** 电脑：图标栏底部「我的」，点开菜单锚在按钮旁（放不下就翻到上方，menu-shell.tsx 的规则） */
export function MeMenu({ items }: { items: MeItem[] }) {
  const tr = useNavT();
  const btn = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const toggle = () => {
    const r = btn.current?.getBoundingClientRect();
    setAt(at || !r ? null : { x: r.right + 12, y: r.bottom });
  };
  return (
    <>
      <button ref={btn} type="button" className={`flex w-full flex-col items-center gap-0.5 rounded-lg py-1.5 text-[11px] transition-colors ${at ? "text-primary" : "text-base-content/60 hover:text-base-content"}`}
        aria-haspopup="menu" aria-expanded={!!at} data-nav-tab="me" onClick={toggle}>
        <NavIcon name="me" />
        <span>{tr("我的")}</span>
      </button>
      {at && typeof document !== "undefined" && createPortal(
        <MenuShell x={at.x} y={at.y} rows={items.length} title={tr("我的")} onClose={() => setAt(null)}>
          {items.map((it) => <ItemRow key={it.id} it={it} onDone={() => setAt(null)} />)}
        </MenuShell>,
        document.body,
      )}
    </>
  );
}

/** 手机「我的」页：上面是同一张表，底部是版本行（侧栏底部那行在手机上藏起来了；ver 是 Sidebar 拉过的那份，不再请求一次） */
export function MePage({ items, ver }: { items: MeItem[]; ver: VersionInfo | null }) {
  return (
    <div className="flex min-h-full flex-col px-2 pb-2" data-nav-page="me">
      <div className="flex flex-col rounded-2xl border border-base-300 bg-base-100 p-1">
        {items.map((it) => <ItemRow key={it.id} it={it} big />)}
      </div>
      <div className="mt-auto px-2 pt-6 text-xs opacity-50" data-me-version>
        Floka Web
        {ver?.version ? <span className="ml-1 font-mono">v{ver.version}{ver.commit ? ` · ${ver.commit}` : ""}</span> : null}
      </div>
    </div>
  );
}
