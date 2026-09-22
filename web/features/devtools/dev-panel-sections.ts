/**
 * 开发者面板的内置分区(性能 / Store / 视口 / 动作)。每个分区一个 mount 函数,
 * 签名与 registerDevSection 的 mount 相同,只是多拿几个采样 ref 和 store。
 * 只被 dev-overlay.tsx(动态加载)引用。
 */
import type GUI from "lil-gui";
import type { RefObject } from "react";
import type { ChatStore } from "../chat/chat-store";
import { setDevMode } from "./dev-mode";
import { allCounters, clearDevEvents, devEvent, makeRateSampler, recentDevEvents, resetCounters } from "./dev-events";

export type OnTick = (fn: (now: number) => void) => void;
export type MeterRefs = { maxGap: RefObject<number>; inputLag: RefObject<number>; longTasks: RefObject<number | null> };

/** 只读读数的通用写法:字符串控件 + listen + disable,onTick 里改值。 */
function addReadouts<T extends Record<string, string>>(f: GUI, r: T): void {
  for (const k of Object.keys(r)) f.add(r, k).listen().disable();
}

/**
 * store 每秒 produce 次数,读 chat-store 已有的 window.__cstraProduceTrail(60 条环,
 * t 是 performance.now())——不往 chat-store 里加计数点。环只有 60 条,速率封顶 60/s。
 */
function produceRate(now: number): number {
  const trail = (window as unknown as { __cstraProduceTrail?: { t: number }[] }).__cstraProduceTrail ?? [];
  return trail.filter((e) => e.t >= now - 1000).length;
}

export function mountPerfSection(gui: GUI, onTick: OnTick, refs: MeterRefs): () => void {
  const f = gui.addFolder("性能 / Perf");
  const r = { 最大帧间隔: "-", 输入到下一帧: "-", longTask: "-", DOM节点: "-", 已渲染消息: "-", 气泡渲染速率: "-", produce速率: "-", 提交突发: "-" };
  addReadouts(f, r);
  const bubbleRate = makeRateSampler("bubble-render");
  const ltRate = makeRateSampler("longtask");
  onTick((now) => {
    r.最大帧间隔 = `${Math.round(refs.maxGap.current)} ms`;
    refs.maxGap.current = 0;
    r.输入到下一帧 = refs.inputLag.current ? `${Math.round(refs.inputLag.current)} ms` : "-";
    refs.inputLag.current = 0;
    r.longTask = refs.longTasks.current === null ? "n/a (Safari)" : `${ltRate(now).toFixed(1)}/s · ≥200ms ×${allCounters().longtask200 ?? 0}`;
    r.DOM节点 = String(document.getElementsByTagName("*").length);
    r.已渲染消息 = String(document.querySelectorAll("[data-mid]").length);
    r.气泡渲染速率 = `${bubbleRate(now).toFixed(1)}/s`;
    r.produce速率 = `${produceRate(now)}/s (≤60)`;
    r.提交突发 = String(allCounters()["commit-burst"] ?? 0);
  });
  return () => f.destroy();
}

export function mountStoreSection(gui: GUI, onTick: OnTick, store: ChatStore): () => void {
  const f = gui.addFolder("Store");
  f.close();
  const r = { activeAgent: "-", agents: "-", messages: "-", streaming: "-", syncState: "-", streamDown: "-", loadingHistory: "-", bgTasks: "-" };
  addReadouts(f, r);
  onTick(() => {
    const s = store.state;
    r.activeAgent = s.activeAgent || "-";
    r.agents = String(s.agents.length);
    r.messages = String(s.messages.length);
    r.streaming = String(s.streaming);
    r.syncState = String(s.syncState);
    r.streamDown = String(s.streamDown);
    r.loadingHistory = String(s.loadingHistory);
    r.bgTasks = String(s.bgTasks.length);
  });
  return () => f.destroy();
}

/** 读安全区 env() 的实测像素值:塞个探针元素量 padding。 */
function measureSafeArea(): string {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;" +
    "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  document.body.appendChild(el);
  const cs = getComputedStyle(el);
  const px = (v: string) => parseFloat(v) || 0;
  const out = `t${px(cs.paddingTop)} r${px(cs.paddingRight)} b${px(cs.paddingBottom)} l${px(cs.paddingLeft)}`;
  el.remove();
  return out;
}

/** PWA 容器诊断(web/CLAUDE.md 容器规则 6 里反复手写的临时浮层,常驻化)。 */
export function mountViewportSection(gui: GUI, onTick: OnTick): () => void {
  const f = gui.addFolder("视口 / Viewport");
  f.close();
  const r = { standalone: "-", inner: "-", visualViewport: "-", safeArea: "-", layoutMode: "-", streamingAttr: "-", hash: "-" };
  addReadouts(f, r);
  const toggles = { 底部对齐线: false, 元素轮廓: false };
  let line: HTMLDivElement | null = null;
  f.add(toggles, "底部对齐线").onChange((v: boolean) => {
    if (v && !line) {
      line = document.createElement("div");
      line.style.cssText = "position:fixed;left:0;right:0;bottom:0;height:2px;background:#f33;z-index:99998;pointer-events:none";
      document.body.appendChild(line);
    } else if (!v && line) {
      line.remove();
      line = null;
    }
  });
  f.add(toggles, "元素轮廓").onChange((v: boolean) => document.documentElement.toggleAttribute("data-dev-outline", v));
  onTick(() => {
    r.standalone = String((navigator as unknown as { standalone?: boolean }).standalone ?? "n/a");
    r.inner = `${window.innerWidth}×${window.innerHeight}`;
    const vv = window.visualViewport;
    r.visualViewport = vv ? `${Math.round(vv.width)}×${Math.round(vv.height)} top=${Math.round(vv.offsetTop)}` : "n/a";
    r.safeArea = measureSafeArea();
    r.layoutMode = document.getElementById("cstra-shell")?.classList.contains("fixed") ? "shell" : "flow";
    r.streamingAttr = document.documentElement.getAttribute("data-streaming") || "?";
    r.hash = location.hash || "-";
  });
  return () => {
    line?.remove();
    document.documentElement.removeAttribute("data-dev-outline");
    f.destroy();
  };
}

export function mountActionsSection(gui: GUI): () => void {
  const f = gui.addFolder("动作 / Actions");
  f.close();
  const a = {
    清空事件: () => clearDevEvents(),
    重置计数: () => resetCounters(),
    复制事件: () => {
      const text = recentDevEvents(200).map((e) => `${new Date(e.t).toISOString()} [${e.kind}] ${e.msg}`).join("\n");
      navigator.clipboard?.writeText(text).catch((e: unknown) => devEvent("error", `复制到剪贴板失败: ${String(e)}`));
    },
    刷新页面: () => location.reload(),
    关闭开发者模式: () => setDevMode(false),
  };
  for (const k of Object.keys(a) as (keyof typeof a)[]) f.add(a, k);
  return () => f.destroy();
}

export function mountBuiltinSections(gui: GUI, onTick: OnTick, store: ChatStore, refs: MeterRefs): (() => void)[] {
  return [mountPerfSection(gui, onTick, refs), mountStoreSection(gui, onTick, store), mountViewportSection(gui, onTick), mountActionsSection(gui)];
}
