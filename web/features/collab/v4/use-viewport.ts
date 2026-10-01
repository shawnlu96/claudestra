"use client";
/**
 * 因果线画布的视口 hook（几何全在 canvas-view.ts，单测 tests/web-collab-causal.test.ts）：量视口、平移缩放、打开时摆一次、
 * Focus 变了才居中、「还有 N 件」往那边平移、「适配全部」。布局与视口宽高无关（causal-model.ts），侧栏收起展开只改可视区域，
 * 视口不用补偿。按钮触发的移动带过渡（glide），拖拽 / 滚轮不带，否则手跟不上。
 */
import { useEffect, useRef, useState } from "react";
import { fitAllView, fitsAll, MAX_K, MIN_K, offscreen, panView, reconcileView, VIEW_PAD, type Dir, type Focus, type View, type ViewCanvas, type ViewState } from "./canvas-view";

const INITIAL: ViewState = { view: { x: VIEW_PAD, y: VIEW_PAD, k: 1 }, placed: false, centered: 0 };

/** 画布视口的宽高，没量到之前是 0 */
export function usePort() {
  const box = useRef<HTMLDivElement>(null);
  const [port, setPort] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPort({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { box, port };
}

/** 点空白 = onBackground */
export function useViewport(canvas: ViewCanvas, port: { w: number; h: number }, focus: Focus | null, onBackground: () => void) {
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const [st, setSt] = useState<ViewState>(INITIAL);
  const [glide, setGlide] = useState(false);
  const [bump, setBump] = useState(false);
  // 渲染时对齐（不走 effect）：reconcileView 没事可做时原样返回同一个对象，所以这里不会来回触发
  const next = reconcileView(st, canvas, port.w, port.h, focus);
  if (next !== st) setSt(next);
  const view = next.view;
  const setView = (f: (v: View) => View, glides = false) => {
    setGlide(glides);
    setSt((s) => ({ ...s, view: f(s.view) }));
  };
  const fitAll = () => {
    if (!port.w) return;
    setView(() => fitAllView(canvas, port.w, port.h), true);
    if (fitsAll(canvas, port.w, port.h)) return;
    setBump(true); // 到文字下限还装不下：按钮和提示动一下（v4.module.css .bump / .beckon，最长 720ms），示意剩下的要靠提示 / 拖拽
    setTimeout(() => setBump(false), 800);
  };
  const pan = (d: Dir) => port.w && setView((v) => panView(canvas, v, port.w, port.h, d), true);
  const off = port.w ? offscreen(canvas, view, port.w, port.h) : null;

  const onWheel = (e: React.WheelEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    setView((v) => {
      const k = Math.min(MAX_K, Math.max(MIN_K, v.k * (e.deltaY < 0 ? 1.1 : 0.9)));
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });
  };
  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.moved = true;
    setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
  };
  const onUp = () => {
    if (drag.current && !drag.current.moved) onBackground();
    drag.current = null;
  };

  const handlers = { onWheel, onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp };
  return { view, glide, bump, fitAll, pan, off, handlers };
}
