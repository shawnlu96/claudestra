"use client";
/**
 * 因果线画布的视口 hook（几何全在 canvas-view.ts，单测 tests/web-collab-causal.test.ts）：量视口、平移缩放、打开时摆一次、
 * Focus 变了才居中、重排后把正在看的框钉住（reanchor）、「还有 N 件」往那边平移、「适配全部」。
 * 按钮触发的移动带过渡（glide），拖拽 / 滚轮不带，否则手跟不上。
 */
import { useEffect, useRef, useState } from "react";
import type { Canvas } from "./causal-model";
import { VIEW_PAD } from "./causal-model";
import { fitAllView, fitsAll, MAX_K, MIN_K, offscreen, panView, reanchor, reconcileView, type Dir, type Focus, type Port, type View, type ViewState } from "./canvas-view";

const INITIAL: ViewState = { view: { x: VIEW_PAD, y: VIEW_PAD, k: 1 }, placed: false, centered: 0 };
const NO_PORT: Port = { left: 0, top: 0, w: 0, h: 0 };

/** 画布视口在页面上的位置和大小；布局按宽高排（causal-model.ts），没量到之前是 0 */
export function usePort() {
  const box = useRef<HTMLDivElement>(null);
  const [port, setPort] = useState(NO_PORT);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setPort({ left: r.left, top: r.top, w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { box, port };
}

/** 点空白 = onBackground；prefer = 选中的任务，重排时优先钉住它 */
export function useViewport(canvas: Canvas, port: Port, focus: Focus | null, prefer: string | null, onBackground: () => void) {
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const [st, setSt] = useState<ViewState>(INITIAL);
  const [laid, setLaid] = useState<{ c: Canvas; p: Port } | null>(null);
  const [glide, setGlide] = useState(false);
  const [bump, setBump] = useState(false);
  // 渲染时对齐（不走 effect）：先按上一次的布局把正在看的框钉住，再做打开时摆放 / Focus 居中；没事可做时都原样返回，不来回触发
  let cur = st;
  if (laid && cur.placed && port.w && (laid.c !== canvas || laid.p !== port)) {
    const view = reanchor(cur.view, laid, canvas, port, prefer);
    if (view !== cur.view && glide) setGlide(false); // 跟着侧栏过渡逐帧补偿，带过渡会拖在后面
    if (view !== cur.view) cur = { ...cur, view };
  }
  if (port.w && (!laid || laid.c !== canvas || laid.p !== port)) setLaid({ c: canvas, p: port });
  const next = reconcileView(cur, canvas, port.w, port.h, focus);
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
