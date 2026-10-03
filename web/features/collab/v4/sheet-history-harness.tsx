/**
 * 真浏览器入口（只给 tests/web-sheet-history-browser.test.ts 打包用，生产导航不 import）：useSheetHistory + 浏览器 history，
 * 外层先挂一个 popstate 监听、回调里 setState（同 chat.tsx 的监听先于整屏页、先触发一次渲染）。不用 act，走真实调度。
 */
import React, { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useSheetHistory } from "./sheet-history";
import { browserHistory } from "../../../lib/hash-nav-browser";

type Api = { open(kind: string): void; close(): void; state(): { sel: string | null; hash: string } };
const api = {} as Api;
/** popstate 监听的注册顺序（测试断言 shell 在前）：整屏页经 port.onPop 注册，外层在自己的 effect 里记 */
const order: string[] = [];
(window as unknown as { popOrder: string[] }).popOrder = order;
const port = { ...browserHistory, onPop: (f: () => void) => { order.push("sheet"); return browserHistory.onPop(f); } };
(window as unknown as { sheetApi: Api }).sheetApi = api;

function Sheet() {
  const [sel, setSel] = useState<string | null>(null);
  const prepare = useSheetHistory(sel !== null, true, `~${sel ?? ""}`, () => setSel(null), port);
  Object.assign(api, { open: (k: string) => { prepare(`~${k}`); setSel(k); }, close: () => setSel(null), state: () => ({ sel, hash: location.hash }) });
  return null;
}
/** 外层用 layout effect 挂监听：它早于子组件的 passive effect，保证注册顺序是 shell 在前（同生产：chat.tsx 早于整屏页挂上） */
function Shell() {
  const [, bump] = useState(0);
  useLayoutEffect(() => {
    const f = () => bump((n) => n + 1);
    order.push("shell");
    window.addEventListener("popstate", f);
    return () => window.removeEventListener("popstate", f);
  }, []);
  return <Sheet />;
}
history.replaceState(null, "", "#chat");
createRoot(document.getElementById("root")!).render(<Shell />);
