/**
 * 真浏览器入口（只给 tests/web-sheet-history-browser.test.ts 打包用，生产导航不 import）：useSheetHistory + 浏览器 history，
 * 外层先挂一个 popstate 监听、回调里 setState（同 chat.tsx 的监听先于整屏页、先触发一次渲染）。不用 act，走真实调度。
 */
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useSheetHistory } from "./sheet-history";
import { browserHistory } from "../../../lib/hash-nav-browser";

type Api = { open(kind: string): void; close(): void; state(): { sel: string | null; hash: string } };
const api = {} as Api;
(window as unknown as { sheetApi: Api }).sheetApi = api;

function Sheet() {
  const [sel, setSel] = useState<string | null>(null);
  const prepare = useSheetHistory(sel !== null, true, `~${sel ?? ""}`, () => setSel(null), browserHistory);
  Object.assign(api, { open: (k: string) => { prepare(`~${k}`); setSel(k); }, close: () => setSel(null), state: () => ({ sel, hash: location.hash }) });
  return null;
}
function Shell() {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    window.addEventListener("popstate", f);
    return () => window.removeEventListener("popstate", f);
  }, []);
  return <Sheet />;
}
history.replaceState(null, "", "#chat");
createRoot(document.getElementById("root")!).render(<Shell />);
