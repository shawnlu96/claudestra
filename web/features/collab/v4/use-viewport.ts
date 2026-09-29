"use client";
/**
 * 因果线画布的视口 hook（几何全在 canvas-view.ts，单测 tests/web-collab-causal.test.ts）：量视口、平移缩放、打开时摆一次、
 * Focus 变了才居中、重排后把正在看的框钉住（reanchor）再滑去收拾好的位置（tidyView）、「还有 N 件」往那边平移、「适配全部」。
 * 按钮触发的移动和重排后的收拾带过渡（glide），拖拽 / 滚轮 / 钉住不带，否则手跟不上、被钉的框会先跳一下。
 */
import { useEffect, useRef, useState } from "react";
import type { Canvas } from "./causal-model";
import { VIEW_PAD } from "./causal-model";
import { fitAllView, fitsAll, MAX_K, MIN_K, offscreen, panView, reanchor, reconcileView, tidyView, type Dir, type Focus, type Port, type View, type ViewState } from "./canvas-view";

const INITIAL: ViewState = { view: { x: VIEW_PAD, y: VIEW_PAD, k: 1 }, placed: false, centered: 0 };
const NO_PORT: Port = { w: 0, h: 0 };
/** 侧栏宽度过渡 180ms（v4.module.css .paneBody）：停稳再重排，过渡期间内容只跟着视口边滑，不逐帧重排 */
const SETTLE_MS = 220;

/** 画布视口的宽高；布局按它排（causal-model.ts），没量到之前是 0 */
export function usePort() {
  const box = useRef<HTMLDivElement>(null);
  const [port, setPort] = useState(NO_PORT);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPort({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { box, port };
}

/** 布局用的尺寸：视口停稳 SETTLE_MS 后才跟上；第一次量到立即用 */
export function useSettled(port: Port): Port {
  const [settled, setSettled] = useState(NO_PORT);
  useEffect(() => {
    const t = setTimeout(() => setSettled(port), settled.w ? SETTLE_MS : 0);
    return () => clearTimeout(t);
  }, [port, settled.w]);
  return settled.w ? settled : port;
}

/** 点空白 = onBackground；prefer = 选中的任务，重排时优先钉住它 */
export function useViewport(canvas: Canvas, port: Port, focus: Focus | null, prefer: string | null, onBackground: () => void) {
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const [st, setSt] = useState<ViewState>(INITIAL);
  const [laid, setLaid] = useState<{ c: Canvas; p: Port } | null>(null);
  const [glide, setGlide] = useState(false);
  const [bump, setBump] = useState(false);
  const [settle, setSettle] = useState<View | null>(null);
  // 渲染时对齐（不走 effect）：先按上一次的布局把正在看的框钉住（瞬时），再做打开时摆放 / Focus 居中；没事可做时都原样返回，不来回触发
  let cur = st;
  if (laid && cur.placed && port.w && (laid.c !== canvas || laid.p !== port)) {
    const view = reanchor(cur.view, laid, canvas, port, prefer);
    if (view !== cur.view && glide) setGlide(false); // 钉住要瞬时：带过渡时新坐标先到、平移后到，被钉的框会先跳一下
    if (view !== cur.view) cur = { ...cur, view };
    if (laid.c.w !== canvas.w || laid.c.h !== canvas.h) {
      const t = tidyView(canvas, cur.view, port);
      if (t !== cur.view) setSettle(t);
    }
  }
  if (port.w && (!laid || laid.c !== canvas || laid.p !== port)) setLaid({ c: canvas, p: port });
  const next = reconcileView(cur, canvas, port.w, port.h, focus);
  if (next !== st) setSt(next);
  const view = next.view;
  const setView = (f: (v: View) => View, glides = false) => {
    setGlide(glides);
    setSt((s) => ({ ...s, view: f(s.view) }));
  };
  // 钉住那一帧画出来之后，再带过渡滑到收拾好的位置
  useEffect(() => {
    if (!settle) return;
    const id = requestAnimationFrame(() => {
      setSettle(null);
      setView(() => settle, true);
    });
    return () => cancelAnimationFrame(id);
  }, [settle]);
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
