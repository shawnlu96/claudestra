"use client";
/**
 * 开发者面板本体。只在开发者模式开着时由 dev-mount.tsx 动态加载——本文件及 stats.js /
 * lil-gui 都不进普通用户的 bundle。
 *
 * 手机是主要使用场景,所以默认只是右下角一个小徽章(FPS · 最大帧间隔 · 提交突发),
 * 点开才是面板:stats.js 三格 + lil-gui(内置分区 + 各处注册进来的分区)+ 最近事件列表。
 *
 * ⚠ portal 到 document.body,绝不能进 chat.tsx 的横滑 translate-x 容器(transform 祖先
 *   会让 fixed 定位整个飞出屏幕,见 web/CLAUDE.md 容器规则 5b)。
 * ⚠ React portal 的合成事件仍沿 React 树冒泡到 #cstra-shell 的 touch 手势处理——根元素
 *   上全部 stopPropagation,拖滑块不会触发横滑导航。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import GUI from "lil-gui";
import { useChatStoreApi, type ChatStore } from "../chat/chat-store";
import { devEventsVersion, recentDevEvents, subscribeDevEvents } from "./dev-events";
import { devSectionsVersion, listDevSections, subscribeDevSections } from "./dev-registry";
import { useBadgeText, useFrameGap, useInputLag, useLongTasks, useMeters, type Meters } from "./dev-meters";
import { mountBuiltinSections, type MeterRefs } from "./dev-panel-sections";

const OPEN_KEY = "cstra_devmode_open";

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false; // 隐私模式读不到 localStorage,按折叠态起
  }
}
function writeOpen(v: boolean) {
  try {
    if (v) localStorage.setItem(OPEN_KEY, "1");
    else localStorage.removeItem(OPEN_KEY);
  } catch {
    /* 隐私模式写不进 localStorage,展开状态只在本次会话有效 */
  }
}

/** lil-gui 生命周期:内置分区 + 注册分区 + 每秒 tick。分区变了(新注册)整个重建,最不容易漏清理。 */
function usePanel(host: RefObject<HTMLDivElement | null>, open: boolean, store: ChatStore, refs: MeterRefs) {
  const sectionsVer = useSyncExternalStore(subscribeDevSections, devSectionsVersion, () => 0);
  useEffect(() => {
    const el = host.current;
    if (!el || !open) return;
    const gui = new GUI({ container: el, title: "Claudestra Dev", width: el.clientWidth || 320 });
    const tickFns: ((now: number) => void)[] = [];
    const onTick = (fn: (now: number) => void) => {
      tickFns.push(fn);
    };
    const cleanups = mountBuiltinSections(gui, onTick, store, refs);
    for (const s of listDevSections()) {
      try {
        const c = s.mount({ gui, onTick });
        if (c) cleanups.push(c);
      } catch (e) {
        console.warn("[devtools] section failed", s.id, e);
      }
    }
    const timer = window.setInterval(() => {
      const now = performance.now();
      for (const fn of tickFns) {
        try {
          fn(now);
        } catch (e) {
          console.warn("[devtools] tick failed", e); // 单个分区出错不拖垮整块面板
        }
      }
    }, 1000);
    return () => {
      clearInterval(timer);
      for (const c of cleanups) c();
      gui.destroy();
    };
  }, [host, open, store, refs, sectionsVer]);
}

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const ROOT: CSSProperties = {
  position: "fixed",
  right: "max(8px, env(safe-area-inset-right))",
  bottom: "calc(max(8px, env(safe-area-inset-bottom)) + var(--cstra-kb-pad, 0px))",
  zIndex: 9000,
  fontFamily: MONO,
  fontSize: 11,
  color: "#eee",
};
const PANEL: CSSProperties = {
  width: "min(calc(100vw - 16px), 360px)",
  maxHeight: "70vh",
  display: "flex",
  flexDirection: "column",
  background: "rgba(20,21,23,.96)",
  border: "1px solid #3a3d42",
  borderRadius: 10,
  boxShadow: "0 8px 30px rgba(0,0,0,.5)",
  overflow: "hidden",
};
const BTN: CSSProperties = { background: "#2b2d31", color: "#fff", border: "1px solid #4a4d52", borderRadius: 6, padding: "4px 8px" };
const BADGE: CSSProperties = { ...BTN, background: "rgba(20,21,23,.9)", color: "#eee", border: "1px solid #3a3d42", borderRadius: 999, padding: "5px 10px" };
const EVENTS: CSSProperties = { maxHeight: 160, overflow: "auto", padding: "6px 8px", borderTop: "1px solid #2a2d31", whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: 1.35 };

function EventList() {
  const ver = useSyncExternalStore(subscribeDevEvents, devEventsVersion, () => 0);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ver]);
  const events = recentDevEvents(50);
  return (
    <div ref={host} style={EVENTS}>
      {events.map((e, i) => (
        <div key={`${e.t}-${i}`} style={e.kind === "error" ? { color: "#f88" } : { opacity: 0.8 }}>
          <span style={{ opacity: 0.55 }}>{new Date(e.t).toLocaleTimeString("en-GB")}</span> [{e.kind}]{" "}
          {e.msg.length > 300 ? `${e.msg.slice(0, 300)}…` : e.msg}
        </div>
      ))}
      {events.length === 0 && <div style={{ opacity: 0.5 }}>（暂无事件：错误 / 横滑探针 / 提交突发 / clientLog 会出现在这里）</div>}
    </div>
  );
}

function Panel({ meters, store, refs, onClose }: { meters: Meters; store: ChatStore; refs: MeterRefs; onClose: () => void }) {
  const statsHost = useRef<HTMLDivElement>(null);
  const guiHost = useRef<HTMLDivElement>(null);
  useEffect(() => {
    statsHost.current?.replaceChildren(meters.fps.dom, meters.ms.dom, meters.gap.dom);
  }, [meters]);
  usePanel(guiHost, true, store, refs);
  return (
    <div style={PANEL}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderBottom: "1px solid #2a2d31" }}>
        <div ref={statsHost} style={{ display: "flex", gap: 2, flex: 1, overflow: "hidden" }} />
        <button type="button" onClick={onClose} style={BTN}>
          收起
        </button>
      </div>
      <div style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
        <div ref={guiHost} className="cstra-dev-gui" />
        <EventList />
      </div>
    </div>
  );
}

export default function DevOverlay() {
  const store = useChatStoreApi();
  const [open, setOpen] = useState(readOpen);
  const meters = useMeters();
  const maxGap = useFrameGap(meters), inputLag = useInputLag(), longTasks = useLongTasks();
  // 必须稳定：refs 是 usePanel 的 effect 依赖，每次渲染新建对象会让整块 lil-gui 销毁重建（折叠状态、滑块值全丢）
  const refs = useMemo<MeterRefs>(() => ({ maxGap, inputLag, longTasks }), [maxGap, inputLag, longTasks]);
  const badge = useBadgeText(!open, refs.maxGap);
  const toggle = () => {
    writeOpen(!open);
    setOpen(!open);
  };
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return createPortal(
    <div data-dev-overlay="" onTouchStart={stop} onTouchMove={stop} onTouchEnd={stop} onPointerDown={stop} onClick={stop} style={ROOT}>
      {open ? (
        <Panel meters={meters} store={store} refs={refs} onClose={toggle} />
      ) : (
        <button type="button" onClick={toggle} style={BADGE}>
          🛠 {badge}
        </button>
      )}
    </div>,
    document.body
  );
}
