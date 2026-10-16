"use client";
/**
 * navV2 全局开关的前端读数（NAVV2-SHELLA1）：Sidebar 与协作层按它在新版整页宿主（v2-host.tsx）和 NAVBAR1 旧布局之间二选一。
 * 每台机器各一份，读 GET /settings（复用 lib/api/settings.ts），挂载与回前台时刷新；读失败保留上次值（内存 + localStorage），
 * 从没读到过就按缺省开。写只在设置里（nav-v2-section.tsx 经 useSettingsFlag，要 manage），成功后经 onSettingsFlagWrite 当场跟上。
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { getSettings } from "@/lib/api/settings";
import { useLang } from "@/lib/i18n";
import { fillParams } from "@/lib/i18n-fill";
import { machines } from "@/lib/machines";
import { onSettingsFlagWrite } from "../chat/components/settings/settings-flag";
import { useNavT } from "./use-nav-t";
import type { VersionInfo } from "@/lib/api/version";
import type { MeItem } from "./me-menu";
import type { NavTab } from "./nav-tab";

/** 宿主里的页：五个入口 + 「我的」下的设置页（v2-host.tsx 的静态注册表按它取） */
export type V2PageId = NavTab | "settings";

/** 宿主传给每一页（和页里各插槽）的同一份：当前机器 / 项目 / 从哪来，外加原有的回调与数据，后继卡只填各自模块 */
export interface V2PageProps {
  fp: string | null;
  /** 协作视图正开着的项目（没有 = null） */
  project: string | null;
  /** 返回落点：子页是它的入口页，入口页为 null */
  from: V2PageId | null;
  narrow: boolean;
  onBack: (() => void) | null;
  /** 在宿主里打开一页（「我的」→ 设置） */
  open: (id: V2PageId) => void;
  /** Sidebar 原有的「我的」条目与动作（useMeItems）；电脑主区宿主没有「我的」页，传空 */
  items: MeItem[];
  version: VersionInfo | null;
}

export const NAV_V2_DEFAULT = true;
const STORE_KEY = "cstra_navv2";

/** read = 这次读到的值（失败 = null），last = 上次留下的值（没有 = null） */
export function resolveNavV2(read: boolean | null, last: boolean | null): boolean {
  return read ?? last ?? NAV_V2_DEFAULT;
}

const known = new Map<string, boolean>();
const subs = new Set<() => void>();
const keyOf = (fp: string | null) => fp ?? "";

function lastOf(fp: string | null): boolean | null {
  const k = keyOf(fp);
  if (known.has(k)) return known.get(k)!;
  try {
    const v = localStorage.getItem(`${STORE_KEY}:${k}`);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null; // 隐私模式 / 无 storage：当没读过，按缺省开
  }
}

function remember(fp: string | null, on: boolean): void {
  const k = keyOf(fp);
  if (known.get(k) === on) return;
  known.set(k, on);
  try {
    localStorage.setItem(`${STORE_KEY}:${k}`, on ? "1" : "0");
  } catch {
    /* 存不下只是下次冷开没有「上次值」，内存里这份照用 */
  }
  for (const cb of subs) cb();
}

const inflight = new Set<string>();
function refresh(fp: string | null): void {
  const k = keyOf(fp);
  if (inflight.has(k)) return;
  inflight.add(k);
  getSettings()
    .then((j) => { if (machines.currentFp() === fp) remember(fp, j.navV2); })
    .catch(() => undefined) // 读失败保留上次值（规格 PM 定 3）；下次回前台再读
    .finally(() => inflight.delete(k));
}

onSettingsFlagWrite((key, fp, on) => { if (key === "navV2") remember(fp, on); });

const subscribe = (cb: () => void) => {
  subs.add(cb);
  const off = machines.subscribe(cb);
  return () => { subs.delete(cb); off(); };
};
const snapshot = () => resolveNavV2(null, lastOf(machines.currentFp()));

/** 当前机器上新版外壳开没开；SSR 与冷开没读到时按缺省开 */
export function useNavV2(): boolean {
  const on = useSyncExternalStore(subscribe, snapshot, () => NAV_V2_DEFAULT);
  const fp = useSyncExternalStore(subscribe, () => machines.currentFp(), () => null);
  useEffect(() => {
    refresh(fp);
    const again = () => refresh(fp);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [fp]);
  return on;
}

/** 新版外壳与回退开关自己的词（写法同 nav-i18n.ts）；表里没有的交给 useNavT（五个入口名、设置等原有词条） */
const EN: Record<string, string> = {
  "新版导航": "New navigation",
  "整页显示今天、项目、团队与我的；关掉回到旧布局，会话与设置两种布局都在。": "Full-page Today, Projects, Team and Me. Turn off to go back to the previous layout; sessions and settings stay reachable in both.",
  "全局生效，只有全权设备能改": "Applies everywhere; only full-access devices can change it",
  "返回": "Back",
};

export function useV2T(): ReturnType<typeof useNavT> {
  const lang = useLang(), base = useNavT();
  return useMemo(() => (s: string, p?: Parameters<typeof base>[1]) => (lang === "en" && Object.hasOwn(EN, s) ? fillParams(EN[s]!, p) : base(s, p)), [lang, base]);
}
