"use client";
/**
 * 五个入口的总装（NAVBAR1）：Sidebar 在 </aside> 前挂一行 <NavShell />。<640 = 手机底部栏 + 入口页面层（PhoneTabs），≥640 = 竖向图标栏 + 同一层，
 * 两端读写同一个 nav-tab.ts；不在当前宽度的那一套整套不渲染。在 aside 上设 --cstra-phone-nav-h / --cstra-rail-w，
 * aside 的 padding 与宽度按它们让位（列表最后一行不被底部栏盖住、原内容在图标栏右边），列表那段 JSX 不用动。
 */
import { useLayoutEffect, useRef } from "react";
import type { VersionInfo } from "@/lib/api/version";
import { useAsks } from "../asks/asks-store";
import { waitsOnOwner } from "../asks/asks-model";
import { useNarrow } from "../collab/collab-detail";
import { useMeItems, type MeActions, type MeItem } from "./me-menu";
import type { NavCounts } from "./nav-button";
import { NavRail, RAIL_W } from "./nav-rail";
import { useNavTab, type NavTab } from "./nav-tab";
import { NavPages } from "./phone-pages";
import { PhoneNav, PHONE_NAV_H } from "./phone-nav";

const useWaits = (): number => useAsks().asks.filter(waitsOnOwner).length;

/** 手机：底部栏 + 页面层（「会话」时不盖） */
function PhoneTabs({ tab, counts, items, version }: { tab: NavTab; counts: NavCounts; items: MeItem[]; version: VersionInfo | null }) {
  return (
    <>
      {tab !== "sessions" && <NavPages key={tab} tab={tab} narrow items={items} version={version} />}
      <PhoneNav tab={tab} counts={counts} />
    </>
  );
}

/** 电脑：图标栏 + 页面层；「我的」在电脑是菜单不是页，store 里留着手机选的「我的」时按「会话」画 */
function RailTabs({ tab, counts, items, version }: { tab: NavTab; counts: NavCounts; items: MeItem[]; version: VersionInfo | null }) {
  const page = tab === "me" ? "sessions" : tab;
  return (
    <>
      {page !== "sessions" && <NavPages key={page} tab={page} narrow={false} items={items} version={version} />}
      <NavRail tab={page} counts={counts} items={items} />
    </>
  );
}

/** unread = Sidebar 算好的会话未读合计（memberUnread(全部会话)：不随搜索与列表分组变，大总管卡、历史里的也算）；version = Sidebar 拉过的版本，「我的」页底部那行用 */
export function NavShell({ me, unread, version }: { me: MeActions; unread: number; version: VersionInfo | null }) {
  const narrow = useNarrow();
  const tab = useNavTab(narrow);
  const counts = { waits: useWaits(), unread };
  const { items, node } = useMeItems(me);
  const mark = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const aside = mark.current?.parentElement;
    if (!aside) return;
    aside.style.setProperty("--cstra-phone-nav-h", narrow ? PHONE_NAV_H : "0px");
    aside.style.setProperty("--cstra-rail-w", narrow ? "0px" : `${RAIL_W}px`);
    return () => {
      aside.style.removeProperty("--cstra-phone-nav-h");
      aside.style.removeProperty("--cstra-rail-w");
    };
  }, [narrow]);
  const Tabs = narrow ? PhoneTabs : RailTabs;
  return (
    <>
      <span ref={mark} hidden />
      <Tabs tab={tab} counts={counts} items={items} version={version} />
      {node}
    </>
  );
}
