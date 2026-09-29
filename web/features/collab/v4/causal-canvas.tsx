"use client";
/**
 * 因果线画布（v4 中区「因果线」标签）：布局全在 causal-model.ts，这里只画。事项框、节点、折叠组是 HTML（好点、好排字），
 * 边是底下一层 SVG（实线已成立 / 流动虚线判定中 / 灰点线还没到，边上写条件原文）；整层用一个 transform 平移缩放。
 * 拖动平移、滚轮缩放、「适配全部」；外面选中任务时把它平移到视口中间。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LedgerDepView, LineView, Tr } from "../collab-model";
import type { Canvas, CEdge, CFold, CNode } from "./causal-model";
import { StageBar } from "./stage-bar";
import v from "./v4.module.css";

/** 选中了什么：任务、边（按依赖记，属性区和任务详情里的因果线点过来的是同一种）、折叠组、「待你处理」 */
export type Selection = { kind: "task"; id: string } | { kind: "edge"; dep: LedgerDepView } | { kind: "fold"; fold: CFold } | { kind: "waits" } | null;

interface View { x: number; y: number; k: number }
const PAD = 24;
const clampK = (k: number) => Math.min(1.6, Math.max(0.3, k));
const STYLE_CLASS = { solid: v.eSolid, flow: v.eFlow, dotted: v.eDotted } as const;

function edgePath(e: CEdge): string {
  const dx = Math.max(40, Math.abs(e.x2 - e.x1) / 2);
  return `M ${e.x1} ${e.y1} C ${e.x1 + dx} ${e.y1}, ${e.x2 - dx} ${e.y2}, ${e.x2} ${e.y2}`;
}

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
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const [view, setView] = useState<View>({ x: PAD, y: PAD, k: 1 });

  const fit = useCallback(() => {
    const el = box.current;
    if (!el || !canvas.w) return;
    const k = clampK(Math.min(1, (el.clientWidth - PAD * 2) / canvas.w, (el.clientHeight - PAD * 2) / canvas.h));
    setView({ x: PAD, y: PAD, k });
  }, [canvas.w, canvas.h]);
  useEffect(fit, [fit]);

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
    if (drag.current && !drag.current.moved) onSelect(null);
    drag.current = null;
  };

  const selId = selection?.kind === "task" ? selection.id : null;
  const selEdge = selection?.kind === "edge" ? `${selection.dep.from}>${selection.dep.to}` : null;
  return (
    <div ref={box} className={v.canvas} onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
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
        {canvas.edges.filter((e) => e.dep.when).map((e) => (
          <button key={`l-${e.id}`} type="button" className={`${v.elabel} ${selEdge === e.id ? v.eSel : ""}`}
            style={{ left: (e.x1 + e.x2) / 2, top: (e.y1 + e.y2) / 2 }} onClick={() => onSelect({ kind: "edge", dep: e.dep })}>
            {e.dep.when}
          </button>
        ))}
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
        <button type="button" className={v.tool} onClick={fit}>{tr("适配全部")}</button>
      </div>
      {canvas.groups.length === 0 && <div className={v.blank}>{tr("没有可画的任务")}</div>}
    </div>
  );
}
