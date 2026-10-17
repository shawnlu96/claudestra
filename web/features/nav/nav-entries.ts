/**
 * 五个入口一张表（NAVBAR1）：手机底部栏和电脑图标栏都读它，顺序、图标、名字、角标来源只写这一处。
 * 「我的」在手机是一页、在电脑是贴在图标栏底部的菜单（rail = false 的那格不进上面那组）。
 */
import type { NavTab } from "./nav-tab";

export type NavIconName = "today" | "projects" | "sessions" | "team" | "me";
export type NavBadge = "waits" | "unread";

export interface NavEntry {
  tab: NavTab;
  /** 两字名（中文原文，经 navTr 翻译） */
  label: string;
  icon: NavIconName;
  badge?: NavBadge;
  /** 电脑图标栏上面那组（「我的」贴底，单独画） */
  rail: boolean;
}

export const NAV_ENTRIES: readonly NavEntry[] = [
  { tab: "today", label: "今天", icon: "today", badge: "waits", rail: true },
  { tab: "projects", label: "项目", icon: "projects", rail: true },
  { tab: "sessions", label: "会话", icon: "sessions", badge: "unread", rail: true },
  { tab: "team", label: "团队", icon: "team", rail: true },
  { tab: "me", label: "我的", icon: "me", rail: false },
];

/** 角标文字：0 不出，超过 99 写 99+ */
export const badgeText = (n: number): string | null => (n > 0 ? (n > 99 ? "99+" : String(n)) : null);
