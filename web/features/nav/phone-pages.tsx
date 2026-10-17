"use client";
/**
 * 入口页面层（NAVBAR1）：选了「会话」以外的入口时，盖在 aside 原内容上（手机在底部栏之上，电脑在图标栏右边），按入口画对应页面；
 * 「会话」不画这一层，露出原来的标题、搜索和列表。切换只做 150ms 淡入，不横滑（横滑留给列表 ↔ 内容）。
 * 顶上一行是入口名 + 机器切换（同原侧栏顶栏）；手机「今天」是 TODAY1 的整页版，自带标题。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { VersionInfo } from "@/lib/api/version";
import { useChatStoreApi } from "../chat/chat-store";
import { MachineSwitcher } from "../machines/machine-switcher";
import { NowBlocksCompact, NowPage } from "../now/now-home";
import { NowProjectList } from "../now/now-projects";
import { scrollToSection } from "../now/today-nav";
import { MePage, type MeItem } from "./me-menu";
import { NAV_ENTRIES } from "./nav-entries";
import { takeTodaySection, useTodaySeq, type NavTab } from "./nav-tab";
import { TeamPage } from "./team-page";
import { useNavT } from "./use-nav-t";

const SAFE_TOP = "var(--cstra-quota-pane-safe-top, env(safe-area-inset-top))";

function FadeIn({ children }: { children: ReactNode }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return <div className={`flex min-h-0 flex-1 flex-col transition-opacity duration-150 ease-out motion-reduce:transition-none ${on ? "opacity-100" : "opacity-0"}`}>{children}</div>;
}

/** 入口名 + 机器切换：位置、高度与原侧栏顶栏那一行一致，切入口时标题不跳 */
function PageHead({ tab }: { tab: NavTab }) {
  const tr = useNavT(), store = useChatStoreApi();
  const label = NAV_ENTRIES.find((e) => e.tab === tab)?.label ?? "";
  return (
    <div className="shrink-0 px-4 pb-2" style={{ paddingTop: `calc(${SAFE_TOP} + 0.75rem)` }}>
      <div className="flex min-h-7 items-center pb-2.5">
        <h2 className="shrink-0 whitespace-nowrap font-semibold">{tr(label)}</h2>
        <span className="ml-auto"><MachineSwitcher onSwitched={() => store.resetForMachine()} /></span>
      </div>
    </div>
  );
}

/** 手机「今天」：TODAY1 整页版；openToday（「看额度」等）带了 section 就滚到那一块 */
function PhoneToday() {
  const ref = useRef<HTMLDivElement>(null);
  const seq = useTodaySeq();
  useEffect(() => {
    const section = takeTodaySection();
    if (!section) return;
    const raf = requestAnimationFrame(() => scrollToSection(ref.current, section));
    return () => cancelAnimationFrame(raf);
  }, [seq]);
  return <div ref={ref} className="flex min-h-0 flex-1 flex-col" style={{ paddingTop: SAFE_TOP }}><NowPage /></div>;
}

function Body({ tab, narrow, items, version }: { tab: NavTab; narrow: boolean; items: MeItem[]; version: VersionInfo | null }) {
  if (tab === "projects") return <NowProjectList fold={false} />;
  if (tab === "team") return <TeamPage />;
  if (tab === "me") return <MePage items={items} ver={version} />;
  // @container：五块里的行按侧栏宽度收起次要信息（now-projects.tsx / now-doing.tsx 的 @max-[20rem]），同侧栏今天条
  return narrow ? null : <div className="@container"><NowBlocksCompact /></div>;
}

export function NavPages({ tab, narrow, items, version }: { tab: NavTab; narrow: boolean; items: MeItem[]; version: VersionInfo | null }) {
  return (
    <div className="absolute right-0 top-0 z-[5] flex flex-col bg-base-200" data-nav-pages={tab}
      style={{ left: "var(--cstra-rail-w, 0px)", bottom: "var(--cstra-phone-nav-h, 0px)" }}>
      <FadeIn>
        {narrow && tab === "today" ? <PhoneToday /> : (
          <>
            <PageHead tab={tab} />
            <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-2 pb-3">
              <Body tab={tab} narrow={narrow} items={items} version={version} />
            </div>
          </>
        )}
      </FadeIn>
    </div>
  );
}
