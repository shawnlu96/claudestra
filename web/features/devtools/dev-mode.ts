/**
 * 开发者模式总开关。
 *
 * 一个布尔值决定整套开发基建(features/devtools/*)挂不挂:设置 → 实验 → 「开发者模式」
 * toggle 写它,`?dev=1` / `?dev=0` URL 参数也能写(与终端页的 `?noWebgl=1` 一样,给
 * 自动化截图和「别人手机上一次性打开」用)。localStorage 持久化,切换即时生效不刷新
 * (面板走 next/dynamic 按需加载,普通用户的 bundle 不含它)。
 *
 * 纯逻辑与 DOM 分开:resolveDevMode / DEV_MODE_KEY 可在 bun test 里跑;isDevMode() 是
 * 同步模块级读取,给热路径(消息气泡渲染计数)用。本文件被根目录的 bun test 编译
 * (root tsconfig 没有 dom lib),所以 window / document / localStorage 统一从 globalThis 取。
 */

import { bumpCounter } from "./dev-events";

export const DEV_MODE_KEY = "cstra_devmode";
const DEV_MODE_PARAM = "dev";

/**
 * 决定启动时的开关值:URL 参数优先(1/true/on → 开,0/false/off → 关),否则沿用
 * 持久化值。返回 `persist` 表示 URL 参数改写了持久化值,调用方要落盘。
 */
export function resolveDevMode(search: string, stored: string | null): { on: boolean; persist: boolean } {
  let param: string | null = null;
  try {
    param = new URLSearchParams(search).get(DEV_MODE_PARAM);
  } catch {
    /* 非法的 search 字符串当作没带参数,沿用持久化值 */
  }
  if (param !== null) {
    const v = param.trim().toLowerCase();
    if (v === "" || v === "1" || v === "true" || v === "on") return { on: true, persist: stored !== "1" };
    if (v === "0" || v === "false" || v === "off") return { on: false, persist: stored === "1" };
  }
  return { on: stored === "1", persist: false };
}

type MinimalGlobals = {
  window?: { location: { search: string } };
  document?: { documentElement: { toggleAttribute(name: string, force?: boolean): boolean } };
  localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
};
const g = globalThis as unknown as MinimalGlobals;

let on = false;
let initialized = false;
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function init() {
  if (initialized || !g.window) return;
  initialized = true;
  let stored: string | null = null;
  try {
    stored = g.localStorage?.getItem(DEV_MODE_KEY) ?? null;
  } catch {
    /* 隐私模式下 localStorage 访问会抛,当作从未开过 */
  }
  const r = resolveDevMode(g.window.location.search, stored);
  on = r.on;
  if (r.persist) persist(on);
}

function persist(v: boolean) {
  try {
    if (v) g.localStorage?.setItem(DEV_MODE_KEY, "1");
    else g.localStorage?.removeItem(DEV_MODE_KEY);
  } catch {
    /* 隐私模式下写不进 localStorage,开关本次会话仍有效,只是不持久 */
  }
}

/** 同步读:热路径用(渲染计数、探针双写)。SSR 恒 false。 */
export function isDevMode(): boolean {
  init();
  return on;
}

/** 业务代码里的一行接入点:开着才计数(消息气泡的重渲染计数就是这么进面板的)。 */
export function devCount(name: string): void {
  if (isDevMode()) bumpCounter(name);
}

export function setDevMode(v: boolean): void {
  init();
  if (on === v) return;
  on = v;
  persist(v);
  g.document?.documentElement.toggleAttribute("data-dev", v);
  notify();
}

/** useSyncExternalStore 的入参。 */
export function subscribeDevMode(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
export function getDevModeSnapshot(): boolean {
  return isDevMode();
}
export function getDevModeServerSnapshot(): boolean {
  return false;
}
