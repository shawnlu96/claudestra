/**
 * 「待你处理」的网页状态（docs 13 §4.4）：侧栏入口、抽屉、聊天气泡上的状态都读这一份。
 * 刷新时机：挂载、自己那条只收 ask 的 SSE（/events?types=ask，没开会话时也实时）、回到前台、可见时每 30 秒兜底。
 * 顺带报网页可见性（POST /presence，推送规则据此判 owner 在不在）：切前台 / 后台各一次，可见时每分钟一次。
 * 凭据读不了台账（403）就当没有待办，也不再轮询。切机器由调用方换 key 重挂（start 见到新 key 先清空）。
 */
import { useSyncExternalStore } from "react";
import { ApiError } from "@/lib/api/client";
import { fetchAsks, followAskEvents, postPresence } from "@/lib/api/asks";
import type { WebAsk } from "./asks-model";

export interface AsksSnap {
  asks: WebAsk[];
  loaded: boolean;
  /** 这个凭据能不能作答（bridge 的 canAnswerAsk）：不能的只看不答 */
  canAnswer: boolean;
  /** 抽屉开着吗；focus = 要滚到的那张卡 */
  open: boolean;
  focus: string | null;
  /** owner 正在用时新来的卡活 ask：顶部横幅（不推送） */
  banner: WebAsk | null;
}

const EMPTY: AsksSnap = { asks: [], loaded: false, canAnswer: true, open: false, focus: null, banner: null };
let snap: AsksSnap = EMPTY;
let machineKey: string | null = null;
let denied = false;
const seen = new Set<string>();
const subs = new Set<() => void>();

function set(p: Partial<AsksSnap>): void {
  snap = { ...snap, ...p };
  for (const f of subs) f();
}

const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

async function refresh(): Promise<void> {
  if (denied) return;
  try {
    const r = await fetchAsks();
    const fresh = r.asks.filter((a) => a.state === "open" && !seen.has(a.id));
    // 第一次拉到的不算「新来的」；之后新来的卡活 ask 在前台就弹横幅
    const bannerAsk = snap.loaded && visible() ? fresh.find((a) => a.blocking === true && a.kind !== "accept") : undefined;
    for (const a of r.asks) seen.add(a.id);
    set({ asks: r.asks, loaded: true, canAnswer: r.canAnswer !== false, ...(bannerAsk ? { banner: bannerAsk } : {}) });
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) {
      denied = true;
      set({ asks: [], loaded: true });
    }
    // 其余（断网、切机器中止）：保留上一份，下次刷新再来
  }
}

function presence(v: boolean): void {
  if (!denied) void postPresence(v).catch(() => undefined); // 心跳丢一次无妨，一分钟后还有下一次
}

export const asksStore = {
  get: (): AsksSnap => snap,
  subscribe(f: () => void): () => void {
    subs.add(f);
    return () => void subs.delete(f);
  },
  refresh,
  openDrawer: (focus: string | null = null) => set({ open: true, focus, banner: null }),
  closeDrawer: () => set({ open: false, focus: null }),
  dismissBanner: () => set({ banner: null }),
  /** 侧栏入口挂载时调；返回卸载。key = 当前机器 */
  start(key: string): () => void {
    if (key !== machineKey) {
      machineKey = key;
      denied = false;
      seen.clear();
      snap = EMPTY;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 300); // 一次作答会连着来几条事件，合成一次
    };
    const onVis = () => {
      presence(visible());
      if (visible()) void refresh();
    };
    const poll = setInterval(() => visible() && void refresh(), 30_000);
    const beat = setInterval(() => visible() && presence(true), 60_000);
    const ctrl = new AbortController();
    void (async () => {
      // 断了就退避重连（5s → 60s）；连上先重拉一次，断线期间的变化不会丢
      for (let wait = 5_000; !ctrl.signal.aborted; wait = Math.min(wait * 2, 60_000)) {
        await followAskEvents({ signal: ctrl.signal, onOpen: () => ((wait = 2_500), void refresh()), onAsk: soon }).catch(() => undefined); // 断线 / 403：等一会儿再连
        if (denied) return;
        await new Promise((r) => setTimeout(r, wait));
      }
    })();
    // 已有窗口时点「待你处理」推送：SW 发 cstra-open-ask（web/public/sw.js），直接打开抽屉定位；别的机器发的先不管（按当前机器显示）
    const onSw = (e: MessageEvent) => {
      const d = e.data as { type?: string; ask?: string };
      if (d?.type === "cstra-open-ask" && d.ask) set({ open: true, focus: d.ask, banner: null });
    };
    navigator.serviceWorker?.addEventListener("message", onSw);
    document.addEventListener("visibilitychange", onVis);
    void refresh();
    presence(visible());
    // 推送深链：/chat?ask=<id> → 打开抽屉并定位到那张卡
    const qs = new URLSearchParams(window.location.search);
    const deep = qs.get("ask");
    if (deep) {
      qs.delete("ask");
      window.history.replaceState(null, "", `${window.location.pathname}${qs.size ? `?${qs}` : ""}${window.location.hash}`);
      set({ open: true, focus: deep });
    }
    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      clearInterval(beat);
      ctrl.abort();
      navigator.serviceWorker?.removeEventListener("message", onSw);
      document.removeEventListener("visibilitychange", onVis);
    };
  },
};

export function useAsks(): AsksSnap {
  return useSyncExternalStore(asksStore.subscribe, asksStore.get, () => EMPTY);
}
