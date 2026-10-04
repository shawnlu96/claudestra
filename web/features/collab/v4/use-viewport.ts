"use client";
/**
 * 因果线画布的视口 hook（几何全在 canvas-view.ts，单测 tests/web-collab-causal.test.ts）：量视口、平移缩放、打开时摆一次、
 * Focus 变了才居中、「还有 N 件」往那边平移、「适配全部」。布局与视口宽高无关（causal-model.ts），侧栏收起展开只改可视区域，
 * 视口不用补偿。按钮触发的移动带过渡（glide），拖拽 / 滚轮不带，否则手跟不上。
 */
import { useEffect, useRef, useState } from "react";
import { fitAllView, fitsAll, MAX_K, MIN_K, offscreen, panView, reconcileView, VIEW_PAD, type Dir, type Focus, type View, type ViewCanvas, type ViewState } from "./canvas-view";

/** 按下后移过这么多 px 才算拖（之内松手 = 点击） */
const DRAG_SLOP = 4;
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
  const drag = useRef<{ id: number; x: number; y: number; vx: number; vy: number; moved: boolean; onButton: boolean } | null>(null);
  const suppress = useRef(false);
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
  // 拖拽：只认主键（触摸 / 笔也报 0），右键 / 中键不平移。按在按钮上（节点卡的文字就在按钮里）也能拖，所以先不抓指针，
  // 移过 DRAG_SLOP 才算拖、才 setPointerCapture；没移过就松手照常是那个按钮的 click / 点空白。拖过之后跟着来的 click 吞掉，
  // 免得松手时误点节点。画布内不选字靠 v4.module.css .canvas 的 user-select（mousedown 的默认动作就是开始选字）。
  const onDown = (e: React.PointerEvent) => {
    suppress.current = false;
    if (e.button !== 0) return;
    const onButton = !!(e.target as HTMLElement).closest("button");
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, onButton };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (e.pointerType === "mouse" && !(e.buttons & 1)) { drag.current = null; return; } // 在画布外松的键（还没抓指针时）
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_SLOP) return;
      d.moved = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.moved) suppress.current = true;
    else if (!d.onButton && e.type === "pointerup") onBackground();
  };
  const onClickCapture = (e: React.MouseEvent) => {
    if (!suppress.current) return;
    suppress.current = false;
    e.stopPropagation();
    e.preventDefault();
  };

  const handlers = { onWheel, onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp, onClickCapture };
  return { view, glide, bump, fitAll, pan, off, handlers };
}
