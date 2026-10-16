"use client";
/**
 * 新版整页宿主（NAVV2-SHELLA1）：navV2 开着时替 NAVBAR1 的 NavShell 挂在 Sidebar 里（V2Shell），电脑另在主区挂一层（V2MainHost，collab-switch.tsx）。
 * 五个入口仍是同一个 nav-tab.ts store、同一组底部栏 / 图标栏 / 「我的」条目；变的只是页面画在哪：
 * - 手机：盖在 aside 原列表上（同 NAVBAR1，底部栏随列表一起滑走），子页（我的 → 设置）带返回；
 * - 电脑：侧栏常驻会话列表（会话与项目永久平级），今天 / 项目 / 团队画在主区、盖住聊天但不卸载它（草稿、滚动不丢），点会话 / 通知直达就退回「会话」。
 * 页面一律从 V2_PAGES 静态注册表取；去过的页面隐藏而不卸载，切回来滚动位置还在。navV2 关掉 = Sidebar 换回 NavShell，本文件整套不渲染。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import type { VersionInfo } from "@/lib/api/version";
import { machines } from "@/lib/machines";
import { useAsks } from "../asks/asks-store";
import { waitsOnOwner } from "../asks/asks-model";
import { useChatStore, useChatStoreApi } from "../chat/chat-store";
import { ChatNavContext, useChatNav } from "../chat/components/nav-context";
import { useNarrow } from "../collab/collab-detail";
import { closeCollab, useCollabNav } from "../collab/collab-nav";
import { MachineSwitcher } from "../machines/machine-switcher";
import { useMeItems, type MeActions, type MeItem } from "./me-menu";
import { MineV2Page } from "./mine-v2-page";
import type { NavCounts } from "./nav-button";
import { NavRail, RAIL_W } from "./nav-rail";
import { setTab, useNavTab, type NavTab } from "./nav-tab";
import { useV2T, type V2PageId, type V2PageProps } from "./nav-v2";
import { PhoneNav, PHONE_NAV_H } from "./phone-nav";
import { ProjectsV2Page } from "./project-v2-page";
import { SessionV2Page } from "./session-v2-page";
import { SettingsV2Page } from "./settings-v2-page";
import { TeamV2Page } from "./team-v2-page";
import { TodayV2Page } from "./today-v2-page";
import css from "./v2-shell.module.css";

interface V2Entry {
  /** 页头标题（中文原文，经 useV2T 翻译） */
  label: string;
  Page: ComponentType<V2PageProps>;
  /** false = 宿主不盖（「会话」露出原列表与聊天） */
  covers: boolean;
  /** 页面自带标题（TODAY1 整页），宿主不画页头 */
  ownHead?: boolean;
}

/** 静态页面注册表：后继卡填各自页面文件，不改这里 */
export const V2_PAGES: Readonly<Record<V2PageId, V2Entry>> = {
  today: { label: "今天", Page: TodayV2Page, covers: true, ownHead: true },
  projects: { label: "项目", Page: ProjectsV2Page, covers: true },
  sessions: { label: "会话", Page: SessionV2Page, covers: false },
  team: { label: "团队", Page: TeamV2Page, covers: true },
  me: { label: "我的", Page: MineV2Page, covers: true },
  settings: { label: "设置", Page: SettingsV2Page, covers: true },
};

const subscribeFp = (cb: () => void) => machines.subscribe(cb);
const currentFp = () => machines.currentFp();
const noFp = () => null;

/** 电脑主区宿主此刻盖没盖着聊天：点会话 / 通知直达（collab-switch 的 closingCollab）据此退回「会话」 */
let mainCovers = false;
export function leaveV2Main(): void {
  if (mainCovers) setTab("sessions");
}

const ChevronLeft = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m15 18-6-6 6-6" />
  </svg>
);

function PageHead({ label, onBack, trail }: { label: string; onBack: (() => void) | null; trail: boolean }) {
  const tr = useV2T(), store = useChatStoreApi();
  return (
    <header className={css.head}>
      {onBack && <button type="button" className={css.back} aria-label={tr("返回")} data-v2-back onClick={onBack}><ChevronLeft /></button>}
      <h2 className={css.title} tabIndex={-1} data-v2-title>{tr(label)}</h2>
      {trail && <span className={css.trail}><MachineSwitcher onSwitched={() => store.resetForMachine()} /></span>}
    </header>
  );
}

/** 子页（「我的」→ 设置）挂在哪个入口下：换了入口就作废，回到入口页本身 */
function useSubPage(tab: NavTab) {
  const [sub, setSub] = useState<{ tab: NavTab; id: V2PageId } | null>(null);
  const current: V2PageId = sub?.tab === tab ? sub.id : tab;
  const back = current === tab ? null : () => setSub(null);
  const open = useCallback((id: V2PageId) => setSub({ tab, id }), [tab]);
  return { current, from: back ? tab : null, back, open };
}

/** 进出子页把焦点放到标题上（键盘 / 读屏从页头开始）；Esc 等于返回 */
function useSubFocus(host: React.RefObject<HTMLDivElement | null>, current: V2PageId, back: (() => void) | null) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    host.current?.querySelector<HTMLElement>(`[data-v2-section="${current}"] [data-v2-title]`)?.focus({ preventScroll: true });
  }, [host, current]);
  useEffect(() => {
    if (!back) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") back(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back]);
}

interface HostProps { at: "aside" | "main"; tab: NavTab; narrow: boolean; items: MeItem[]; version: VersionInfo | null; notices?: ReactNode }

/** 页面层：当前页可见，去过的页隐藏常挂；「会话」与电脑上的「我的」不盖 */
export function V2Host({ at, tab, narrow, items, version, notices }: HostProps) {
  const fp = useSyncExternalStore(subscribeFp, currentFp, noFp);
  const { project } = useCollabNav();
  const { current, from, back, open } = useSubPage(tab);
  const entry = V2_PAGES[current];
  const covers = entry.covers && !(at === "main" && current === "me");
  const [seen, setSeen] = useState<V2PageId[]>([]);
  if (covers && !seen.includes(current)) setSeen([...seen, current]);
  const host = useRef<HTMLDivElement>(null);
  useSubFocus(host, current, back);
  useEffect(() => {
    if (at !== "main") return;
    mainCovers = covers;
    return () => { mainCovers = false; };
  }, [at, covers]);
  const props: V2PageProps = { fp, project, from, narrow, onBack: back, open, items, version };
  return (
    <div ref={host} className={`${css.host} ${at === "main" ? css.inMain : css.inAside}`} hidden={!covers} data-v2-host={at} data-v2-current={current}>
      {/* 电脑主区盖住了聊天顶上的同步 / 更新提示：盖着期间在这里挂 chat.tsx 传来的同一对组件（零高度锚点，同 ChatMain），不盖就卸掉 */}
      {notices && covers && <div className="relative" data-v2-notices>{notices}</div>}
      {seen.map((id) => {
        const e = V2_PAGES[id], on = id === current;
        const { Page } = e;
        return (
          <section key={id} className={`${css.page} ${on && from ? css.slideIn : ""}`} hidden={!on} data-v2-section={id}>
            {!e.ownHead && <PageHead label={e.label} onBack={on ? back : null} trail={narrow} />}
            <div className={`${css.body} ${e.ownHead ? css.ownHead : ""}`}><Page {...props} from={on ? from : null} /></div>
          </section>
        );
      })}
    </div>
  );
}

/** 电脑主区（collab-switch.tsx 挂一行）：今天 / 项目 / 团队盖在聊天上；从这些页里开会话要先退回「会话」，开项目就留着当返回落点 */
function MainHost({ notices }: { notices: ReactNode }) {
  const tab = useNavTab(false);
  const nav = useChatNav();
  const { project } = useCollabNav();
  const collab = useRef(project);
  collab.current = project;
  // 页面里的开会话 / 开项目都走 nav.toContent（now-ui useOpeners）：等这次点击的更新落定，没开协作视图 = 开的是会话
  const value = useMemo(() => ({
    ...nav,
    toContent: () => {
      nav.toContent();
      requestAnimationFrame(() => { if (!collab.current) leaveV2Main(); });
    },
  }), [nav]);
  // 在项目里点图标栏的今天 / 项目 / 团队：收起协作视图露出那一页（协作层在宿主之上）
  const lastTab = useRef(tab);
  useEffect(() => {
    if (lastTab.current !== tab && collab.current && tab !== "sessions" && tab !== "me") closeCollab();
    lastTab.current = tab;
  }, [tab]);
  // 会话从别处换了（⌘K、深链）：露出聊天，同 collab-switch 的规则；冷开第一次落座不算
  const active = useChatStore((s) => s.state.activeAgent);
  const seen = useRef(active);
  useEffect(() => {
    if (seen.current && seen.current !== active) leaveV2Main();
    seen.current = active;
  }, [active]);
  return (
    <ChatNavContext.Provider value={value}>
      <V2Host at="main" tab={tab} narrow={false} items={[]} version={null} notices={notices} />
    </ChatNavContext.Provider>
  );
}

/** notices = 聊天顶上的同步条与更新提示（chat.tsx 经 CollabSwitch 传来；本文件不 import 它们，免得测试与截图入口牵进构建时生成的 build-info） */
export function V2MainHost({ on, notices }: { on: boolean; notices?: ReactNode }) {
  const narrow = useNarrow();
  return on && !narrow ? <MainHost notices={notices} /> : null;
}

const useWaits = (): number => useAsks().asks.filter(waitsOnOwner).length;

/** Sidebar 里替 NavShell 的那一套（同一组 props）：手机底部栏 + 页面层，电脑只有图标栏（页面在主区） */
export function V2Shell({ me, unread, version }: { me: MeActions; unread: number; version: VersionInfo | null }) {
  const narrow = useNarrow();
  const tab = useNavTab(narrow);
  const counts: NavCounts = { waits: useWaits(), unread };
  const { items, node } = useMeItems(me);
  // aside 按这两个变量给底部栏 / 图标栏让位（sidebar.tsx 的 className）；换回旧外壳时由 NavShell 自己再设
  const mark = useCallback((el: HTMLSpanElement | null) => {
    const style = el?.parentElement?.style;
    if (!style) return;
    style.setProperty("--cstra-phone-nav-h", narrow ? PHONE_NAV_H : "0px");
    style.setProperty("--cstra-rail-w", narrow ? "0px" : `${RAIL_W}px`);
    return () => ["--cstra-phone-nav-h", "--cstra-rail-w"].forEach((k) => style.removeProperty(k));
  }, [narrow]);
  return (
    <>
      <span ref={mark} hidden data-v2-shell />
      {narrow ? (
        <>
          <V2Host at="aside" tab={tab} narrow items={items} version={version} />
          <PhoneNav tab={tab} counts={counts} />
        </>
      ) : <NavRail tab={tab === "me" ? "sessions" : tab} counts={counts} items={items} />}
      {node}
    </>
  );
}
