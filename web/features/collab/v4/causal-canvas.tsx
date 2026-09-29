"use client";
/**
 * 因果线画布（v4 中区「因果线」标签）：布局全在 causal-model.ts，这里只画。事项框、节点、折叠组是 HTML（好点、好排字），
 * 边是底下一层 SVG（实线已成立 / 流动虚线判定中 / 灰点线还没到，边上写条件原文）；整层用一个 transform 平移缩放。
 * 拖动平移、滚轮缩放、「适配全部」；外面选中任务时把它平移到视口中间。标签避让、打开时的视口、「还有 N 件在右边」在 canvas-view.ts。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LedgerDepView, LineView, Tr } from "../collab-model";
import type { Box, Canvas, CFold, CNode } from "./causal-model";
import { edgePath, initialView, offscreen, placeLabels, VIEW_PAD, type View } from "./canvas-view";
import { StageBar } from "./stage-bar";
import v from "./v4.module.css";

/** 选中了什么：任务、边（按依赖记，属性区和任务详情里的因果线点过来的是同一种）、折叠组、「待你处理」 */
export type Selection = { kind: "task"; id: string } | { kind: "edge"; dep: LedgerDepView } | { kind: "fold"; fold: CFold } | { kind: "waits" } | null;

const clampK = (k: number) => Math.min(1.6, Math.max(0.3, k));
const STYLE_CLASS = { solid: v.eSolid, flow: v.eFlow, dotted: v.eDotted } as const;
const MORE = { right: "还有 {n} 件在右边 →", down: "下面还有 {n} 件 ↓", left: "← 左边还有 {n} 件", up: "↑ 上面还有 {n} 件" } as const;

function NodeCard(props: { n: CNode; line: LineView | undefined; act: string; selected: boolean; hot: boolean; onClick: () => void; tr: Tr }) {
  const { n, line, act, selected, onClick, tr } = props;
  const cls = `${v.node} ${n.kind === "mini" ? v.mini : ""} ${selected ? v.sel : ""} ${props.hot ? v.hot : ""} ${line ? v[line.tone] ?? "" : ""}`;
  return (
    <button type="button" className={cls} style={{ left: n.x, top: n.y, width: n.w, height: n.h }} onClick={onClick}>
      <span className={v.nh}>
        <span className={v.tid}>{n.id}</span>
        <span className={v.nt}>{n.task.title}</span>
      </span>
      {n.kind === "full" && (
        <>
          <StageBar stage={n.task.stage} before={n.task.stageBefore} kind={n.task.kind} />
          <span className={v.nf}>
            <span className={v.who}>{line?.agent ?? line?.delegate ?? tr("未派")}</span>
            <span className={v.act}>{act || line?.stageLabel}</span>
          </span>
        </>
      )}
    </button>
  );
}

/** 视口：平移缩放、打开时摆放（canvas-view.ts initialView）、「适配全部」、外面选中任务时居中、视口外还剩几件；点空白 = onBackground */
function useViewport(canvas: Canvas, focus: string | null, onBackground: () => void) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const [view, setView] = useState<View>({ x: VIEW_PAD, y: VIEW_PAD, k: 1 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // 图的尺寸变了（或第一次量到视口）才重摆；只是换了个对象不动，免得实时刷新把用户拖好的位置冲掉
  const placedFor = useRef("");
  useEffect(() => {
    const key = `${canvas.w}x${canvas.h}`;
    if (!size.w || placedFor.current === key) return;
    placedFor.current = key;
    setView(initialView(canvas, size.w, size.h));
  }, [canvas, size]);
  const fitAll = useCallback(() => {
    const el = box.current;
    if (!el || !canvas.w) return;
    const k = Math.min(1, (el.clientWidth - VIEW_PAD * 2) / canvas.w, (el.clientHeight - VIEW_PAD * 2) / canvas.h);
    setView({ x: VIEW_PAD, y: VIEW_PAD, k: clampK(k) });
  }, [canvas.w, canvas.h]);
  const off = size.w ? offscreen(canvas, view, size.w, size.h) : null;

  // 从大纲点任务：把它的框平移到视口中间（折叠在组里的就平移到那一组）
  useEffect(() => {
    const el = box.current;
    const id = focus ? canvas.boxOf.get(focus) : null;
    const b = id ? [...canvas.groups.flatMap((g) => [...g.nodes, ...g.folds])].find((x) => x.id === id) : null;
    if (!el || !b) return;
    setView((cur) => ({ ...cur, x: el.clientWidth / 2 - (b.x + b.w / 2) * cur.k, y: el.clientHeight / 2 - (b.y + b.h / 2) * cur.k }));
  }, [focus, canvas]);

  const onWheel = (e: React.WheelEvent) => {
    const r = box.current!.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    setView((cur) => {
      const k = clampK(cur.k * (e.deltaY < 0 ? 1.1 : 0.9));
      return { k, x: px - ((px - cur.x) * k) / cur.k, y: py - ((py - cur.y) * k) / cur.k };
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
    setView((cur) => ({ ...cur, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
  };
  const onUp = () => {
    if (drag.current && !drag.current.moved) onBackground();
    drag.current = null;
  };

  const handlers = { onWheel, onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp };
  return { box, view, fitAll, off, handlers };
}

function EdgeLabels({ canvas, selEdge, onSelect }: { canvas: Canvas; selEdge: string | null; onSelect: (s: Selection) => void }) {
  const labels = useMemo(() => placeLabels(canvas.edges, canvas.groups.flatMap((g): Box[] => [...g.nodes, ...g.folds])), [canvas]);
  return labels.map((l) => {
    const e = canvas.edges.find((x) => x.id === l.id)!;
    const cls = `${l.dot ? v.edot : v.elabel} ${selEdge === e.id ? v.eSel : ""}`;
    const pick = () => onSelect({ kind: "edge", dep: e.dep });
    return l.dot
      ? <button key={`l-${l.id}`} type="button" className={cls} style={{ left: l.x, top: l.y }} title={e.dep.when} aria-label={e.dep.when} onClick={pick} />
      : <button key={`l-${l.id}`} type="button" className={cls} style={{ left: l.x, top: l.y, width: l.w }} title={e.dep.when} onClick={pick}>{e.dep.when}</button>;
  });
}

export function CausalCanvas(props: {
  canvas: Canvas;
  lines: ReadonlyMap<string, LineView>;
  actionText: (id: string) => string;
  selection: Selection;
  /** 刚推进的那一个：全屏唯一的品牌色 */
  hot: string | null;
  focus: string | null;
  onSelect: (s: Selection) => void;
  tr: Tr;
}) {
  const { canvas, lines, selection, focus, onSelect, tr } = props;
  const { box, view, fitAll, off, handlers } = useViewport(canvas, focus, () => onSelect(null));

  const selId = selection?.kind === "task" ? selection.id : null;
  const selEdge = selection?.kind === "edge" ? `${selection.dep.from}>${selection.dep.to}` : null;
  return (
    <div ref={box} className={v.canvas} {...handlers}>
      <div className={v.world} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        {canvas.groups.map((g) => (
          <div key={g.id} className={v.group} style={{ left: g.x, top: g.y, width: g.w, height: g.h }}>
            <span className={v.gt}>{g.title || tr("未归事项")}</span>
            {g.done > 0 && <span className={v.gdone}>✓ {g.done}</span>}
          </div>
        ))}
        <svg className={v.edges} width={canvas.w} height={canvas.h}>
          {canvas.edges.map((e) => (
            <g key={e.id} className={`${STYLE_CLASS[e.style]} ${selEdge === e.id ? v.eSel : ""}`}>
              <path d={edgePath(e)} className={v.eLine} />
              <path d={edgePath(e)} className={v.eHit} onClick={() => onSelect({ kind: "edge", dep: e.dep })} />
            </g>
          ))}
        </svg>
        <EdgeLabels canvas={canvas} selEdge={selEdge} onSelect={onSelect} />
        {canvas.groups.flatMap((g) => g.nodes).map((n) => (
          <NodeCard key={n.id} n={n} line={lines.get(n.id)} act={props.actionText(n.id)} selected={selId === n.id} hot={props.hot === n.id} tr={tr}
            onClick={() => onSelect({ kind: "task", id: n.id })} />
        ))}
        {canvas.groups.flatMap((g) => g.folds).map((f) => (
          <button key={f.id} type="button" className={`${v.node} ${v.mini} ${v.fold}`} style={{ left: f.x, top: f.y, width: f.w, height: f.h }}
            onClick={() => onSelect({ kind: "fold", fold: f })}>
            {tr("{n} 件在等 {x}", { n: f.members.length, x: f.waitFor })}
          </button>
        ))}
      </div>
      <div className={v.tools}>
        <button type="button" className={v.tool} onClick={fitAll}>{tr("适配全部")}</button>
      </div>
      {off && (Object.keys(MORE) as (keyof typeof MORE)[]).filter((d) => off[d] > 0).map((d) => (
        <button key={d} type="button" className={`${v.more} ${v[`more_${d}`]}`} onClick={fitAll}>{tr(MORE[d], { n: off[d] })}</button>
      ))}
      {canvas.groups.length === 0 && <div className={v.blank}>{tr("没有可画的任务")}</div>}
    </div>
  );
}
