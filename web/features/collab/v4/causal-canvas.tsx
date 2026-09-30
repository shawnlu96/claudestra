"use client";
/**
 * 因果线画布（v4 中区「因果线」标签）：布局全在 causal-model.ts，这里只画。事项框、节点、折叠组是 HTML（好点、好排字），
 * 边是底下一层 SVG（实线已成立 / 流动虚线判定中 / 灰点线还没到，边上写条件原文）；整层用一个 transform 平移缩放。
 * 拖动平移、滚轮缩放、「适配全部」、点「还有 N 件」往那边平移；外面明确选中任务时把它平移到视口中间，数据刷新不动视口。
 * 视口 hook 在 use-viewport.ts，标签避让与视口几何在 canvas-view.ts；选中状态的形状在 v4-selection.ts。
 */
import { useMemo } from "react";
import type { LineView, Tr } from "../collab-model";
import type { Box, Canvas, CEdge, CNode } from "./causal-model";
import { edgePath, placeLabels, type Focus } from "./canvas-view";
import { usePort, useViewport } from "./use-viewport";
import { depKey, edgeSel, type Selection } from "./v4-selection";
import { StageBar } from "./stage-bar";
import v from "./v4.module.css";

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

/** 这根线里有没有被选中的依赖（任务详情点进来的是单条，画布上点的是整根线的全部） */
const edgeSelected = (e: CEdge, sel: Selection) => sel?.kind === "edge" && e.deps.some((d) => sel.keys.includes(depKey(d)));

function EdgeLabels({ canvas, selection, onSelect }: { canvas: Canvas; selection: Selection; onSelect: (s: Selection) => void }) {
  const labels = useMemo(() => placeLabels(canvas.edges, canvas.groups.flatMap((g): Box[] => [...g.nodes, ...g.folds])), [canvas]);
  return labels.map((l) => {
    const e = canvas.edges.find((x) => x.id === l.id)!;
    const cls = `${l.dot ? v.edot : v.elabel} ${edgeSelected(e, selection) ? v.eSel : ""}`;
    const pick = () => onSelect(edgeSel(e.deps));
    const full = e.deps.map((d) => d.when).filter(Boolean).join(" / ");
    return l.dot
      ? <button key={`l-${l.id}`} type="button" className={cls} style={{ left: l.x, top: l.y }} title={full} aria-label={full} onClick={pick} />
      : <button key={`l-${l.id}`} type="button" className={cls} style={{ left: l.x, top: l.y, width: l.w }} title={full} onClick={pick}>{e.label}</button>;
  });
}

export function CausalCanvas(props: {
  canvas: Canvas;
  lines: ReadonlyMap<string, LineView>;
  actionText: (id: string) => string;
  selection: Selection;
  /** 刚推进的那一个：全屏唯一的品牌色 */
  hot: string | null;
  focus: Focus | null;
  onSelect: (s: Selection) => void;
  tr: Tr;
}) {
  const { canvas, lines, selection, focus, onSelect, tr } = props;
  const { box, port } = usePort();
  const { view, glide, bump, fitAll, pan, off, handlers } = useViewport(canvas, port, focus, () => onSelect(null));

  const selId = selection?.kind === "task" ? selection.id : null;
  return (
    <div ref={box} className={v.canvas} {...handlers}>
      <div className={`${v.world} ${glide ? v.glide : ""}`} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        {canvas.groups.map((g) => (
          <div key={g.id} className={v.group} style={{ left: g.x, top: g.y, width: g.w, height: g.h }}>
            <span className={v.gt}>{g.title || tr("未归事项")}</span>
            {g.done > 0 && <span className={v.gdone}>✓ {g.done}</span>}
          </div>
        ))}
        <svg className={v.edges} width={canvas.w} height={canvas.h}>
          {canvas.edges.map((e) => (
            <g key={e.id} className={`${STYLE_CLASS[e.style]} ${edgeSelected(e, selection) ? v.eSel : ""}`}>
              <path d={edgePath(e)} className={v.eLine} />
              <path d={edgePath(e)} className={v.eHit} onClick={() => onSelect(edgeSel(e.deps))} />
            </g>
          ))}
        </svg>
        <EdgeLabels canvas={canvas} selection={selection} onSelect={onSelect} />
        {canvas.groups.flatMap((g) => g.nodes).map((n) => (
          <NodeCard key={n.id} n={n} line={lines.get(n.id)} act={props.actionText(n.id)} selected={selId === n.id} hot={props.hot === n.id} tr={tr}
            onClick={() => onSelect({ kind: "task", id: n.id })} />
        ))}
        {canvas.groups.flatMap((g) => g.folds).map((f) => (
          <button key={f.id} type="button" className={`${v.node} ${v.mini} ${v.fold}`} style={{ left: f.x, top: f.y, width: f.w, height: f.h }}
            onClick={() => onSelect({ kind: "fold", id: f.id })}>
            {tr("{n} 件在等 {x}", { n: f.members.length, x: f.waitFor })}
          </button>
        ))}
      </div>
      <div className={v.tools}>
        <button type="button" className={`${v.tool} ${bump ? v.bump : ""}`} onClick={fitAll}>{tr("适配全部")}</button>
      </div>
      {off && (Object.keys(MORE) as (keyof typeof MORE)[]).filter((d) => off[d] > 0).map((d) => (
        <button key={d} type="button" className={`${v.more} ${v[`more_${d}`]} ${bump ? v.beckon : ""}`} onClick={() => pan(d)}>{tr(MORE[d], { n: off[d] })}</button>
      ))}
      {canvas.groups.length === 0 && <div className={v.blank}>{tr("没有可画的任务")}</div>}
    </div>
  );
}
