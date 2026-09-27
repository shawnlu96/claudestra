"use client";
import { useSyncExternalStore } from "react";
import { createHandoff, hostInfo, takeHandoff } from "@/lib/api/system";
import { reloadChatPrefs } from "@/lib/chat-prefs";
import { reloadFontPrefs } from "@/lib/font-prefs";
import { reloadThemeVars } from "@/lib/theme-vars";
import { applyHandoff, collectHandoff, handoffIdFromHash, isDesktopBrowser, localEntryUrl, probeBlockedByBrowser, probeMatches } from "./local-hop-logic";

/**
 * 在这台电脑上打开中继网页时，不绕东京中继一圈：确认是同一台电脑就整页切到本机直托管入口（http://127.0.0.1:<端口>），
 * 那里是回环——免配对、本机打开目录等本机功能齐全。判定与键白名单见 local-hop-logic.ts；偏好经 bridge 一次性交接（local-api/handoff.ts）。
 * Safari 拦「https 页面 → http 回环」，探不通时压一条横幅，点一下同样切过去；探到的是别的实例（fp 不同）= 不是这台，什么都不做。
 * `?relay=1` 打开 = 这个标签页留在中继（调试中继本身用）。
 */
const STAY_KEY = "cstra_stay_relay";
const DISMISS_KEY = "cstra_local_hop_dismissed";
// Chrome 对「公网页面 → 回环」先弹授权框，请求要等用户点完才走；给足时间，超时就当探不到
const PROBE_TIMEOUT_MS = 20_000;

let banner: { port: number } | null = null;
const subs = new Set<() => void>();
function setBanner(next: { port: number } | null): void {
  banner = next;
  subs.forEach((f) => f());
}

function stayOnRelay(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get("relay") === "1") sessionStorage.setItem(STAY_KEY, "1");
    return sessionStorage.getItem(STAY_KEY) === "1" || localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false; // 存储不可用（隐私模式）：照常探测，最坏多探一次
  }
}

async function probe(port: number, fp: string): Promise<"same" | "other" | "unreachable"> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/local-probe`, { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return r.ok && probeMatches(await r.json(), fp) ? "same" : "other";
  } catch {
    return "unreachable"; // 被浏览器拦 / 授权被拒 / 本机没在听：分不清，交给调用方按浏览器决定要不要横幅
  }
}

/** 整页切到本机入口；偏好交接失败不挡切换（本机页面只是少了外观偏好） */
export async function hopToLocal(port: number): Promise<void> {
  let id: string | undefined;
  try {
    const entries = collectHandoff(localStorage);
    if (Object.keys(entries).length) id = (await createHandoff(entries)).id;
  } catch (e) {
    console.warn("[local-hop] 偏好交接失败，照常切换:", (e as Error).message);
  }
  window.location.replace(localEntryUrl(port, window.location.search, id));
}

/** 中继模式开机后调一次（不阻塞渲染）：同网 + 桌面才探，探到同一台就切过去 */
export async function maybeHopToLocal(fp: string): Promise<void> {
  if (stayOnRelay() || !isDesktopBrowser(navigator.userAgent, navigator.maxTouchPoints ?? 0)) return;
  const entry = (await hostInfo().catch(() => null))?.localEntry; // 拉不到主机信息：留在中继，不影响使用
  if (!entry?.sameNetwork) return;
  const found = await probe(entry.port, fp);
  if (found === "same") return hopToLocal(entry.port);
  if (found === "unreachable" && probeBlockedByBrowser(navigator.userAgent)) setBanner({ port: entry.port });
}

export function dismissLocalHop(): void {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* 存不住就只关这一次：下次打开再提示 */
  }
  setBanner(null);
}

export function useLocalHopBanner(): { port: number } | null {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => banner,
    () => null,
  );
}

/**
 * 本机入口开机：地址里带 #handoff=<id> 就取回中继页面交过来的偏好，只补本机缺的，重建外观 CSS 后整页重载一次让主题 / 语言生效。
 * 返回 true = 正在重载，调用方别再往下走。
 */
export async function receiveHandoff(): Promise<boolean> {
  const id = handoffIdFromHash(window.location.hash);
  if (!id) return false;
  history.replaceState(null, "", window.location.pathname + window.location.search);
  try {
    const written = applyHandoff((await takeHandoff(id)).entries, localStorage);
    if (!written.length) return false;
    reloadThemeVars();
    reloadFontPrefs();
    reloadChatPrefs();
    window.location.reload();
    return true;
  } catch (e) {
    console.warn("[local-hop] 取回偏好失败:", (e as Error).message);
    return false;
  }
}
